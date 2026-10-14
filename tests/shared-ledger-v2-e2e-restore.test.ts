/** X15 验收线 3：中心用旧备份恢复。顺序固定：冻结（三成员都拿维护锁、调度拿不到）→ 升服务代际（恢复即越过备份代际并记
 * restoredFrom）→ 撤旧租约（旧代际的租约 / 意图命令一律 stale_generation）→ 核对本机已确认回执（备份后的逐项报丢、备份前的仍
 * committed）→ 序列倒退在每个实例的读缓存上报警，丢掉缓存重建。被丢掉的合并不静默消失：本机日志留证、不自动重跑。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { acquireMaintenance } from "../src/lib/scheduler-maintenance.js";
import { centralEnvelope } from "../src/lib/scheduler-central-context.js";
import { parseCommand, v2ObjectDigest, type V2Command, type V2Receipt } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import {
  cleanupWorlds, evidence, H1, mergeIntent, mergeReady, outcome, runMerge, versions, world, type Instance, type World,
} from "./shared-ledger-v2-e2e-world.test.js";

afterEach(cleanupWorlds);

const lockAt = (i: Instance) => ({ path: join(i.dir, "scheduler-maintenance.lock"), request: join(i.dir, "scheduler-maintenance.request"),
  marker: join(i.dir, "update-inflight.json") });
/** 冻结 = each member's update-kind maintenance lease (as `update` / X13 take it): its scheduler cannot start a pass meanwhile. */
async function freeze(w: World) {
  const held: { release(): void }[] = [];
  for (const i of w.all) {
    const path = join(i.dir, "ledger.sqlite");
    openLedger(path); closeLedger(path);
    const reader = new LedgerReader(path);
    try { held.push((await acquireMaintenance("update", { ...lockAt(i), reader }))!); } finally { reader.close(); }
  }
  return { held, release: () => { for (const h of held.splice(0)) h.release(); } };
}

describe("X15 验收线 3：旧备份恢复", () => {
  test("冻结 → 升代际 → 撤旧租约 → 核对已确认回执；序列倒退报警并重建缓存；丢掉的合并只留证不重跑", async () => {
    const w = await world(), T = await mergeReady(w);
    const confirmed: { label: string; command: V2Command; receipt: V2Receipt }[] = [];
    const sent = async (label: string, command: V2Command) => {
      const receipt = await w.local.send(command);
      confirmed.push({ label, command, receipt });
      return receipt;
    };
    await sent("title-1", w.local.cmd("task.set", { taskId: T, expectedRev: 1, expectedSpecRev: 1, patch: { title: "备份前" } }));
    const backup = w.k.center.backup(), backupSeq = w.k.center.rows().serverSeq;

    // 备份之后：又一次改动 + 一次完整的 owner 合并（本机日志 confirmed，中心记 done）
    await sent("title-2", w.local.cmd("task.set", { taskId: T, expectedRev: 2, expectedSpecRev: 1, patch: { title: "备份后" } }));
    const ctx = await mergeIntent(w, T, H1);
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "succeeded", reported: true });
    expect(w.local.journal.read(ctx)).toMatchObject({ state: "confirmed", result: { state: "succeeded" } });
    const before = await Promise.all(w.all.map(i => i.refresh()));
    const highSeq = before[0]!.serverSeq;
    expect(highSeq).toBeGreaterThan(backupSeq);

    // 1. 冻结：三成员维护锁都在，调度的维护锁拿不到
    const frozen = await freeze(w);
    for (const i of w.all) expect(await acquireMaintenance("scheduler", lockAt(i))).toBeNull();

    // 2. 升服务代际：恢复旧备份，代际 1 → 2，restoredFrom 记下备份的代际与序列
    w.k.center.restore(backup);
    expect(w.k.center.generation()).toMatchObject({ serviceGeneration: 2, restoredFrom: { serviceGeneration: 1, serverSeq: backupSeq } });

    // 3. 撤旧租约：恢复后没有任何主场租约；还按旧代际发的租约 / 意图命令都被拒，零写入
    expect(w.k.center.rows().leases.size).toBe(0);
    const seq = w.k.center.rows().serverSeq, from = w.k.center.log.length;
    const oldGen = (type: "lease.renew" | "lease.acquire", requestId: string) => parseCommand({ ...V2_FIXTURE_SCOPE, serviceGeneration: 1, epoch: 1,
      bootId: "boot-local", requestId, type, payload: type === "lease.renew" ? { taskId: T, homeInstanceId: "local" }
        : { ...versions(w, T), homeInstanceId: "local" } });
    await expect(w.local.raw(oldGen("lease.renew", "old-gen-renew"))).rejects.toThrow("stale_generation");
    await expect(w.local.raw(oldGen("lease.acquire", "old-gen-acquire"))).rejects.toThrow("stale_generation");
    expect(w.served(from)).toEqual(["lease.renew 409", "lease.acquire 409"]);
    expect(w.k.center.rows().serverSeq).toBe(seq);

    // 4. 核对已确认回执：备份前的仍 committed；备份后的逐项报丢（不静默吞掉），合并的本机日志作为证据
    const reconciled = await Promise.all(confirmed.map(async c => ({ label: c.label, serverSeq: c.receipt.serverSeq,
      status: (await w.local.receipt(c.command)).status })));
    expect(reconciled).toEqual([{ label: "title-1", serverSeq: expect.any(Number), status: "committed" },
      { label: "title-2", serverSeq: expect.any(Number), status: "unknown" }]);
    const merged = w.local.journal.read(ctx)!.result!;
    const mergeReport = parseCommand({ ...centralEnvelope(ctx), requestId: `result-${v2ObjectDigest(merged)}`, type: "operation.result", payload: { result: merged } });
    expect((await w.local.receipt(mergeReport)).status).toBe("unknown");
    expect(w.k.center.rows().intents.has(ctx.operationId)).toBe(false);
    const lost = reconciled.filter(r => r.status === "unknown");
    evidence(w, "restore", [
      ...lost.map(r => ({ item: `local:receipt:${r.label}`, instance: "local" as const, local: { serverSeq: r.serverSeq, confirmed: true },
        center: { status: r.status, restoredFrom: backupSeq } })),
      { item: `local:intent:${ctx.operationId}`, instance: "local", local: { journal: "confirmed", ghCalls: w.ghCalls().length },
        center: { receipt: "unknown", intent: "absent after restore" } },
    ]);

    // 5. 序列倒退：每个实例的读缓存都报 rollback；丢掉缓存重建后是新代际的完整快照、不再报警
    for (const i of w.all) {
      const alarm = await i.refresh();
      expect(alarm).toMatchObject({ rollback: true });
      expect(alarm.serverSeq).toBeLessThan(highSeq);
      i.rebuild();
      const fresh = await i.refresh();
      expect(fresh).toMatchObject({ rollback: false, value: { serviceGeneration: 2 } });
      expect(fresh.value.tasks.find(t => t.id === T)!.title).not.toBe("备份后");
    }

    // 丢掉的合并：本机不自动重跑（日志回放，不调 gh、不调中心），解冻后由 owner 按证据处理
    const replayFrom = w.k.center.log.length;
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "succeeded", replayed: true });
    expect(w.ghCalls()).toHaveLength(1);
    expect(w.served(replayFrom)).toEqual([]);
    frozen.release();
    // 解冻后主场在新代际下重新领租（fence 来自重建后的快照），旧代际不复用
    const fresh = await w.local.send(w.local.cmd("lease.acquire", { ...versions(w, T), homeInstanceId: "local" }));
    expect(fresh).toMatchObject({ serviceGeneration: 2, command: "lease.acquire" });
    expect(w.k.center.rows().leases.get(T)).toMatchObject({ serviceGeneration: 2 });
  });
});

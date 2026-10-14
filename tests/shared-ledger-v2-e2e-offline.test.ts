/** X15 验收线 2（下）：断网（中心端口关闭）与迁移过程中有活单两项故障演练。
 * 断网：只读缓存 / 草稿可用并显示最近成功时间，派单、阶段、合并、网页开卡全停，peer B 在途成果只进它本机 outbox；端口恢复后
 * 不自动重交，先查回执 / 租约 / 版本再显式重交一次，不重复启动。迁移活单：X13 整组迁移遇到在途出借单——未声明逐项拒绝且中心零调用；
 * 显式导入核租约后切换且不重发；切换回包丢失则全组冻结、按批次回执留证，不重试。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeLendCentralOrder } from "../src/lib/ledger-lend-central-home.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { readSharedLedgerMode, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { migrationCenter, runExecutionMigration, type MigrationPlan } from "../src/lib/shared-ledger-v2-migration.js";
import { approvedAsk, featureRows } from "./helpers/shared-ledger-v2-fake-center-kit.js";
import {
  cleanupWorlds, D, evidence, F, H0, H1, mergeIntent, mergeReady, outcome, REPO, RESOURCE, runMerge, versions, world, type World,
} from "./shared-ledger-v2-e2e-world.test.js";

afterEach(cleanupWorlds);

/** A write order on card T, claimed by peer B: the worker it started is the one in-flight piece of work during the outage. */
async function claimedWrite(w: World, T: string) {
  w.k.center.seed({ tasks: [{ ...w.task(T), stage: "build", head: null }] });
  const created = await w.local.send(w.local.cmd("lend.create", { ...versions(w, T), featureId: F, family: "codex", step: "write",
    executorInstanceId: "peer-b", specArtifactId: "artifact", head: H0, round: 0, branch: "feat/x15-offline", base: "main", grantId: "grant-b", grantDigest: D }));
  const o = w.k.center.rows().orders.get(created.result.entityId)!;
  const common = { ...V2_FIXTURE_SCOPE, orderId: o.orderId, taskId: T, specRev: o.specRev, round: 0, leaseGen: 1, serviceGeneration: o.serviceGeneration,
    epoch: o.epoch, bootId: o.bootId, executorInstanceId: "peer-b", worker: { kind: "peer_agent" as const, instanceId: "peer-b", agentId: "worker-b" } };
  await w.peerB.raw(w.peerB.cmd("lend.claim", { claim: { ...common, head: H0, grantId: o.grantId, grantDigest: o.grantDigest, claimedAt: w.k.center.time } }));
  const result = w.peerB.cmd("lend.result", { result: { ...common, expectedHead: H0, head: H1, operationId: "lend-offline", resultDigest: D,
    verdict: "delivered", summary: "peer B 断网期间完成", artifactIds: [], observedAt: w.k.center.time } });
  return { orderId: o.orderId, result };
}

describe("X15 演练 · 断网：中心不可用", () => {
  test("只读缓存与草稿、最近成功时间；派单 / 阶段 / 合并 / 开卡全停；在途成果进 outbox；恢复后显式核对再重交一次", async () => {
    const w = await world(), T = await mergeReady(w, "task-offline"), M = await mergeReady(w, "task-merge");
    const ctx = await mergeIntent(w, M, H1);
    const { orderId, result } = await claimedWrite(w, T);
    // peer B's worker starts on its claim: the number of claims the center saw for the order is the number of starts
    const claims = () => w.k.center.log.filter(e => e.command === "lend.claim").length;
    const askId = ctx.authorizationAskId;
    await w.local.client.queryAsk({ ...V2_FIXTURE_SCOPE, askId });
    for (const i of w.all) await i.refresh();
    const lastOk = w.local.client.status().lastSuccessAt, before = w.k.center.log.length;

    w.center.down();
    w.k.center.advance(5_000);
    // 只读缓存（显示用，带最近成功时间）与本机草稿照常；在线刷新失败但缓存不被清掉
    for (const i of w.all) {
      await expect(i.refresh()).rejects.toThrow("unavailable");
      expect(i.cache.read(w.k.center.time)).toMatchObject({ lastSuccessAt: expect.any(Number), rollback: false });
    }
    expect(w.local.client.cachedAsk({ ...V2_FIXTURE_SCOPE, askId })).toMatchObject({ displayOnly: true, authoritative: false, value: { decision: "approved" } });
    await w.local.outbox.saveDraft("draft-offline", "断网期间的规格草稿");
    expect(w.local.outbox.view().drafts.map(d => d.id)).toEqual(["draft-offline"]);
    // 派单、阶段、网页开卡、业务授权复核都停（没有本机回退，也不把缓存里的 approved 当授权）
    const dispatch = w.local.cmd("intent.create", { ...versions(w, T), action: "dispatch", node: "write", operationId: "op-offline", head: null,
      round: 0, dependencyDigest: D, authorizationAskId: null, authorizationDigest: null, resources: RESOURCE });
    const stage = w.local.cmd("task.stage", { ...versions(w, M), from: "merge", to: "done", round: 0, authorizationAskId: askId });
    await expect(w.local.send(dispatch)).rejects.toThrow("unavailable");
    await expect(w.local.send(stage)).rejects.toThrow("unavailable");
    const spec = (V2_DTO_FIXTURES.task.valid as { spec: unknown }).spec;
    await expect(w.peerA.send(w.peerA.cmd("task.new", { featureId: F, expectedRev: w.peerA.view().feature.rev, itemId: null, title: "断网开卡",
      plan: "", kind: "code", repository: REPO, spec }))).rejects.toThrow("unavailable");
    await expect(w.local.client.checkAuthorization(w.local.cmd("authorization.check", { ...versions(w, M), askId,
      bind: w.k.center.rows().asks.get(askId)!.bind, action: "merge" }))).rejects.toThrow("unavailable");
    expect(w.local.client.status()).toEqual({ available: false, lastSuccessAt: lastOk });
    // 合并停在动作之前：X8 复核拿不到中心 → blocked，假 gh 一次都没跑
    expect(outcome(await runMerge(w, ctx))).toEqual({ state: "blocked", resourceHeld: true, reported: false, replayed: false });
    expect(w.ghCalls()).toEqual([]);
    // peer B 在途成果：发不出去 → 只存它本机 outbox（非权威、待重交）
    await expect(w.peerB.raw(result)).rejects.toThrow("unavailable");
    expect(await w.peerB.outbox.saveResult(result)).toEqual({ state: "pending_submission", authoritative: false });
    expect(w.k.center.log.length).toBe(before);

    // 恢复：端口回来后什么都不会自己发
    w.center.restore();
    await Bun.sleep(50);
    expect(w.k.center.log.length).toBe(before);
    expect(w.k.center.rows().orders.get(orderId)).toMatchObject({ status: "claimed", leaseGen: 1 });
    expect(w.peerB.outbox.view().results.map(r => [r.command.requestId, r.state])).toEqual([[result.requestId, "pending_submission"]]);
    // 显式重交前先核：回执 unknown（没提交过）、订单仍 claimed 且租约代际 / 头 / 规格版本与 outbox 条目一致
    const pending = w.peerB.outbox.view().results[0]!.command as typeof result;
    expect((await w.peerB.receipt(pending)).status).toBe("unknown");
    const view = await w.peerB.transport.call("lend", { orderId });
    expect(view.order).toMatchObject({ status: "claimed", leaseGen: pending.payload.result.leaseGen, head: pending.payload.result.expectedHead,
      specRev: pending.payload.result.specRev });
    expect(view.lease!.expiresAt).toBeGreaterThan(view.now);
    const from = w.k.center.log.length;
    expect((await w.peerB.raw(pending)).command).toBe("lend.result");
    expect(w.served(from)).toEqual(["lend.result 200"]);
    expect(w.k.center.rows().orders.get(orderId)).toMatchObject({ status: "done", resultOperationId: "lend-offline" });
    expect(claims()).toBe(1);
    // 合并在恢复后照常跑一次；本机阶段命令同样显式重交（同一 requestId：回执先查，再发一次）
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "succeeded", reported: true, replayed: false });
    expect(w.ghCalls()).toHaveLength(1);
    expect((await w.local.send(stage)).command).toBe("task.stage");
    evidence(w, "offline", [
      { item: `peer-b:lend:${orderId}`, instance: "peer-b", local: { outbox: "pending_submission", requestId: result.requestId },
        center: { receiptWhilePending: "unknown", order: "claimed→done", resubmissions: 1 } },
      { item: `local:command:${stage.requestId}`, instance: "local", local: { status: "unavailable", lastSuccessAt: lastOk },
        center: { committedAfterRestore: true } },
    ]);
  });
});

const ORDER = "old-order", OLD_TASK = "old-task";
/** Member ledgers on the real schema: 本机 owns the card and the claimed order lent to peer B; peer B holds the same order. */
function memberLedgers(w: World) {
  const row = { taskId: OLD_TASK, project: "project", peer: "peer-b", family: "codex" as const, step: "review" as const, specRev: 1, round: 0,
    head: H0, repo: REPO, pr: null, wire: { v: 1, orderId: ORDER }, text: "合成订单", sha256: D, leaseMs: 60_000, createdBy: "scheduler", branch: null, base: null };
  for (const i of [w.local, w.peerB]) {
    const path = join(i.dir, "ledger.sqlite"), db = openLedger(path);
    try {
      if (i === w.local) createTask(db, { actor: "owner", now: 1_000 }, { project: "project", id: OLD_TASK, title: "迁移中的卡", kind: "code",
        agent: "agent-x15", extra: { sharedFeatureId: "feature" } });
      db.run("PRAGMA foreign_keys = OFF");
      writeLendCentralOrder(db, ORDER, i === w.local ? row : { ...row, peer: "local" }, 1_000);
      db.run("UPDATE lend_orders SET status = 'claimed', leaseGen = 1, worker = 'worker-b' WHERE orderId = ?", [ORDER]);
    } finally { closeLedger(path); }
  }
}
async function migrationWorld() {
  const w = await world();
  w.k.center.seed({ features: [featureRows("feature", "task", "planning").feature], asks: [approvedAsk("ask", "feature", "task")] });
  for (const i of w.all) await writeSharedLedgerMode("feature", { authorityMode: "planning", sharedPlanning: true }, i.dir);
  memberLedgers(w);
  return { w, center: migrationCenter(w.local.transport), mode: (i: { dir: string }) => readSharedLedgerMode("feature", i.dir) };
}
function plan(w: World, orders: MigrationPlan["orders"]): MigrationPlan {
  const { manifestDigest: _a, evidence: _b, featureIds: _c, frozenAt: _d, batchId: _e, ...manifest } =
    structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Record<string, any>;
  manifest.mappings = manifest.mappings.map((m: any) => m.kind === "feature" ? { ...m, sourceId: "feature" } : m);
  return { batchId: "batch-x15", centerId: "center", featureIds: ["feature"], homeBootId: "boot-local", manifest: manifest as MigrationPlan["manifest"],
    orders, members: w.all.map(i => ({ label: i.label, instanceId: i.actor.instanceId, dir: i.id, versionVerified: true })) };
}
const orderRow = (i: { dir: string }) => {
  const path = join(i.dir, "ledger.sqlite"), db = openLedger(path);
  try { return db.query("SELECT status, leaseGen, head, worker FROM lend_orders WHERE orderId = ?").get(ORDER); } finally { closeLedger(path); }
};

describe("X15 演练 · 迁移过程中有活单", () => {
  test("在途出借单没声明：本机与 peer B 逐项拒绝，三成员模式不动，中心零调用", async () => {
    const { w, center, mode } = await migrationWorld(), from = w.k.center.log.length;
    const out = await runExecutionMigration({ root: w.root, plan: plan(w, {}), center, mode: "commit" });
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.findings.map(f => `${f.code}:${f.item}`).sort())
      .toEqual(["lend_not_declared:order", "lend_unsettled:old-order", "lend_unsettled:peer-b:old-order"]);
    expect(w.k.center.log.length).toBe(from);
    for (const i of w.all) expect(mode(i)).toEqual({ authorityMode: "planning", sharedPlanning: true });
    expect(orderRow(w.peerB)).toMatchObject({ status: "claimed", leaseGen: 1 });
  });

  test("显式导入并核对租约（gen 1 / 头）：整组切到 execution、中心领租；订单不重发，peer B 的在途单原样保留", async () => {
    const { w, center, mode } = await migrationWorld(), from = w.k.center.log.length;
    const out = await runExecutionMigration({ root: w.root, plan: plan(w, { [ORDER]: { disposition: "import", leaseGen: 1, head: H0 } }), center, mode: "commit" });
    expect(out).toMatchObject({ status: "switched", epochs: { feature: 2 }, leases: ["task"] });
    expect(w.served(from)).toEqual(["lease.acquire 200"]);
    expect(w.k.center.log.slice(from).filter(e => e.route === "migrations").map(e => e.status)).toEqual([200]);
    for (const i of w.all) expect(mode(i)).toMatchObject({ authorityMode: "execution", centerExecution: { centerFeatureId: "feature", epoch: 2 } });
    expect(w.served(from).some(c => c.startsWith("lend."))).toBe(false);
    expect([orderRow(w.local), orderRow(w.peerB)]).toEqual([{ status: "claimed", leaseGen: 1, head: H0, worker: "worker-b" },
      { status: "claimed", leaseGen: 1, head: H0, worker: "worker-b" }]);
  });

  test("切换回包丢失：全组冻结在 migrating 门后，按批次回执留证（committed），迁移命令不重试", async () => {
    const { w, center, mode } = await migrationWorld(), from = w.k.center.log.length;
    w.k.center.inject({ kind: "drop", route: "migrations" });
    const out = await runExecutionMigration({ root: w.root, plan: plan(w, { [ORDER]: { disposition: "import", leaseGen: 1, head: H0 } }), center, mode: "commit" });
    expect(out).toMatchObject({ status: "frozen", step: "switch", batch: { status: "committed", batchId: "batch-x15" } });
    expect(w.k.center.log.slice(from).map(e => `${e.route} ${e.status}`)).toEqual(["migrations dropped", "migration 200"]);
    for (const i of w.all) expect(mode(i).migrating).toEqual({ batchId: "batch-x15", kind: "execute" });
    const frozen = join(w.root, "shared-ledger-v2-migration", "batch-x15", "frozen.json");
    expect(existsSync(frozen)).toBe(true);
    const record = JSON.parse(readFileSync(frozen, "utf8"));
    expect(record).toMatchObject({ state: "frozen_pending_pm", step: "switch", batch: { status: "committed" } });
    expect(record.holds.map((h: { instanceId: string; hold: string }) => `${h.instanceId}:${h.hold}`)).toEqual(["local:migrating", "peer-a:migrating", "peer-b:migrating"]);
    expect(w.served(from)).toEqual([]); // 冻结后不领租、不发任何执行命令
    evidence(w, "migration-live-order", [{ item: "center:migration:batch-x15", instance: "local",
      local: { frozen: record.state, holds: record.holds.length }, center: { batch: record.batch.status } }]);
  });
});

/** X15 验收线 2（上）：失租、主场进程崩溃、丢回执三项故障演练。中心在本地端口，合并跑假 gh。
 * 每项都断言：unknown 逐项留证（本机日志 / 中心意图与资源，写进演练根目录的 drills/*.json 再读回）、没有盲目重试（中心命令
 * 序列逐条对上，重跑只回放本机日志）、没有重复启动（假 gh 调用次数）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { centralEnvelope } from "../src/lib/scheduler-central-context.js";
import { checkSchedulerCentral } from "../src/lib/scheduler-central-gate.js";
import { parseCommand, v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { testChildEnv } from "./test-env.js";
import {
  cleanupWorlds, connectionOf, D, evidence, H1, lease, mergeIntent, mergeReady, outcome, RESOURCE, runMerge, versions, world, type World,
} from "./shared-ledger-v2-e2e-world.test.js";

afterEach(cleanupWorlds);

const intentRow = (w: World, operationId: string) => w.k.center.rows().intents.get(operationId)!;
const held = (w: World, operationId: string) => w.k.center.rows().resources.filter(r => r.intentId === operationId).map(r => r.state);
/** A fresh dispatch on the same file: the center must refuse it while the unknown operation still holds the resource. */
const overlapping = (w: World, taskId: string, operationId: string) => w.local.send(w.local.cmd("intent.create", { ...versions(w, taskId),
  action: "dispatch", node: "write", operationId, head: w.task(taskId).head, round: 0, dependencyDigest: D,
  authorizationAskId: null, authorizationDigest: null, resources: RESOURCE }));
const MERGE_CHECKS = ["authorization.check 200", "intent.check 200"];

describe("X15 演练 · 失租：动作在途时主场租约过期", () => {
  test("合并结果转 unknown，资源继续占着；重跑只回放、重领租也不重发，假 gh 只跑一次", async () => {
    const w = await world(), T = await mergeReady(w), ctx = await mergeIntent(w, T, H1), from = w.k.center.log.length;
    const o = await runMerge(w, ctx, { during: () => w.k.center.advance(61_000) });
    expect(outcome(o)).toEqual({ state: "unknown", resourceHeld: true, reported: false, replayed: false });
    expect(o.reason).toBe("lease_expired");
    // 动作后的复核撞上过期租约 → 本机判 unknown；上报同样被中心以 lease_expired 拒，中心不记任何结果
    expect(w.served(from)).toEqual([...MERGE_CHECKS, "authorization.check 200", "intent.check 409", "operation.result 409"]);
    expect(w.ghCalls()).toHaveLength(1);
    expect(intentRow(w, ctx.operationId)).toMatchObject({ status: "submitted", attempts: 1 });
    expect(held(w, ctx.operationId)).toEqual(["held"]);
    expect(w.k.center.rows().operationResults.has(ctx.operationId)).toBe(false);
    const journal = w.local.journal.read(ctx)!;
    expect(journal).toMatchObject({ state: "unknown", result: { state: "unknown", operationId: ctx.operationId, epoch: 1 } });

    // 没有盲目重试：重跑只读本机日志；本机重领租约（新任期）后同样不重发，旧意图在新任期里也过不了中心复核
    const again = w.k.center.log.length;
    expect(outcome(await runMerge(w, ctx))).toEqual({ state: "unknown", resourceHeld: true, reported: false, replayed: true });
    await lease(w, T);
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "unknown", replayed: true });
    expect(w.served(again)).toEqual(["lease.acquire 200"]);
    await expect(checkSchedulerCentral(ctx, { instanceId: "local", client: w.local.transport.scheduler, lock: { held: () => true } }))
      .rejects.toThrow("lease_expired");
    await expect(overlapping(w, T, "op-after-lease-loss")).rejects.toThrow("resource_busy");
    expect(w.ghCalls()).toHaveLength(1);

    const ev = evidence(w, "lease-loss", [{ item: `local:intent:${ctx.operationId}`, instance: "local",
      local: { journal: journal.state, result: journal.result!.state, ghCalls: w.ghCalls().length },
      center: { intent: intentRow(w, ctx.operationId).status, resources: held(w, ctx.operationId) } }]);
    expect(ev.items[0]).toMatchObject({ local: { journal: "unknown", result: "unknown", ghCalls: 1 }, center: { intent: "submitted", resources: ["held"] } });
  });
});

describe("X15 演练 · 崩溃", () => {
  test("主场进程在假 gh 之后被 SIGKILL：重启的主场只回放 started 日志，不再合并；新 boot 拿不走旧租约，旧意图过不了新任期", async () => {
    const w = await world(), T = await mergeReady(w), ctx = await mergeIntent(w, T, H1), from = w.k.center.log.length;
    const lib = (m: string) => JSON.stringify(join(import.meta.dir, "..", "src", "lib", m));
    // 独立 bun 进程 = 本机主场：自己开签名传输与本机日志，跑完假 gh 立刻被杀，来不及写结果或上报
    const child = `
      import { generateKeyPairSync } from "node:crypto";
      import { executeSchedulerCentral } from ${lib("scheduler-central.ts")};
      import { SchedulerCentralJournal } from ${lib("scheduler-central-journal.ts")};
      import { createStage2Transport } from ${lib("shared-ledger-v2-transport.ts")};
      const a = JSON.parse(process.env.X15_CRASH), pair = generateKeyPairSync("ed25519");
      const key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
      const t = createStage2Transport({ key, projectId: "project", connection: a.connection });
      await executeSchedulerCentral(a.context, { instanceId: "local", client: t.scheduler, lock: { held: () => true } },
        new SchedulerCentralJournal(a.journal), async () => {
          Bun.spawnSync(["gh", "pr", "merge", "7", "--squash", "--match-head-commit", a.context.head], { env: process.env });
          process.kill(process.pid, "SIGKILL");
          await new Promise(() => {});
        });`;
    const proc = Bun.spawn(["bun", "-e", child], { env: testChildEnv({ PATH: w.ghEnv.PATH, GH_LOG: w.ghEnv.GH_LOG, X15_CRASH: JSON.stringify({ context: ctx,
      connection: connectionOf(w, "local", w.local.actor), journal: join(w.local.dir, "central-journal") }) }), stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    expect(proc.signalCode).toBe("SIGKILL");
    expect(w.ghCalls()).toHaveLength(1);
    expect(w.served(from)).toEqual(MERGE_CHECKS);
    expect(w.local.journal.read(ctx)).toMatchObject({ state: "started", result: null });

    // 重启后的主场：同一操作只回放，不调中心、不调 gh
    const restarted = w.k.center.log.length;
    expect(outcome(await runMerge(w, ctx))).toEqual({ state: "unknown", resourceHeld: true, reported: false, replayed: true });
    expect(w.served(restarted)).toEqual([]);
    expect(w.ghCalls()).toHaveLength(1);
    // 新 bootId 领租：旧租约还活着 → resource_busy；过期后新任期领到，旧意图（旧 boot）在新任期里复核被拒
    const newBoot = (requestId: string) => parseCommand({ ...V2_FIXTURE_SCOPE, serviceGeneration: 1, epoch: 1, bootId: "boot-local-2", requestId,
      type: "lease.acquire", payload: { ...versions(w, T), homeInstanceId: "local" } });
    await expect(w.local.raw(newBoot("boot2-lease-1"))).rejects.toThrow("resource_busy");
    w.k.center.advance(61_000);
    expect((await w.local.raw(newBoot("boot2-lease-2"))).command).toBe("lease.acquire");
    await expect(checkSchedulerCentral(ctx, { instanceId: "local", client: w.local.transport.scheduler, lock: { held: () => true } })).rejects.toThrow();
    expect(intentRow(w, ctx.operationId)).toMatchObject({ status: "submitted", attempts: 1, bootId: "boot-local" });
    expect(held(w, ctx.operationId)).toEqual(["held"]);
    expect(w.ghCalls()).toHaveLength(1);

    evidence(w, "home-crash", [{ item: `local:intent:${ctx.operationId}`, instance: "local",
      local: { journal: w.local.journal.read(ctx)!.state, exit: proc.signalCode, ghCalls: w.ghCalls().length },
      center: { intent: intentRow(w, ctx.operationId).status, resources: held(w, ctx.operationId) } }]);
  });

  test("中心进程重启：回执与行都在，重放已提交命令拿回原回执；主场租约作废、需重领，旧意图保持 submitted 等对账", async () => {
    const w = await world(), T = await mergeReady(w), ctx = await mergeIntent(w, T, H1);
    const stage = w.local.cmd("task.set", { taskId: T, expectedRev: w.task(T).rev, expectedSpecRev: 1, patch: { title: "重启前" } });
    const first = await w.local.send(stage), boot = w.k.center.generation().bootId;
    w.k.center.restart();
    expect(w.k.center.generation()).toMatchObject({ serviceGeneration: 1 });
    expect(w.k.center.generation().bootId).not.toBe(boot);
    const from = w.k.center.log.length;
    expect(await w.local.send(stage)).toEqual(first);
    expect(w.served(from)).toEqual([]); // X7 先查回执：已提交就不再发
    expect(w.k.center.rows().leases.size).toBe(0);
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "blocked", resourceHeld: true, reported: false });
    expect(w.ghCalls()).toEqual([]);
    expect(intentRow(w, ctx.operationId).status).toBe("pending");
  });
});

describe("X15 演练 · 丢回执：中心已提交，回包丢了", () => {
  test("X7：阶段命令回包丢失 → unavailable；显式对账查回执 committed，同一 requestId 不再发送、不重复写", async () => {
    const w = await world(), T = await mergeReady(w);
    w.k.center.seed({ tasks: [{ ...w.task(T), stage: "build", head: null }] });
    const c = w.local.cmd("task.stage", { ...versions(w, T), from: "build", to: "review", round: 0, authorizationAskId: null });
    w.k.center.inject({ kind: "drop", route: "commands", command: "task.stage" });
    const from = w.k.center.log.length;
    await expect(w.local.send(c)).rejects.toThrow("unavailable");
    expect(w.served(from)).toEqual(["task.stage dropped"]);
    expect(w.local.client.status().available).toBe(false);
    const seq = w.k.center.rows().serverSeq, unknown = { requestId: c.requestId, status: "unknown", error: "unavailable" };
    // 对账：回执查询为 committed；X7 同一命令再走一遍只拿回执，中心零写入
    const lookup = await w.local.receipt(c);
    expect(lookup.status).toBe("committed");
    const replay = await w.local.send(c);
    expect(replay).toEqual(lookup.receipt!);
    expect(w.served(from)).toEqual(["task.stage dropped"]);
    expect(w.k.center.rows().serverSeq).toBe(seq);
    expect(w.task(T)).toMatchObject({ stage: "review" });
    evidence(w, "lost-receipt-stage", [{ item: `local:command:${c.requestId}`, instance: "local", local: unknown,
      center: { lookup: lookup.status, serverSeq: lookup.receipt!.serverSeq } }]);
  });

  test("X8：合并结果上报丢回包 → unknown 留在本机日志；重跑只回放；按 requestId 查回执确认中心已记 done", async () => {
    const w = await world(), T = await mergeReady(w), ctx = await mergeIntent(w, T, H1), from = w.k.center.log.length;
    w.k.center.inject({ kind: "drop", route: "commands", command: "operation.result" });
    const o = await runMerge(w, ctx);
    expect(outcome(o)).toEqual({ state: "unknown", resourceHeld: true, reported: false, replayed: false });
    expect(w.served(from)).toEqual([...MERGE_CHECKS, ...MERGE_CHECKS, "operation.result dropped"]);
    const journal = w.local.journal.read(ctx)!;
    expect(journal).toMatchObject({ state: "unknown", result: { state: "succeeded" } });
    expect(outcome(await runMerge(w, ctx))).toMatchObject({ state: "unknown", replayed: true });
    expect(w.served(from)).toHaveLength(5);
    expect(w.ghCalls()).toHaveLength(1);
    // 显式对账：上报命令的 requestId 由结果摘要定，查中心回执 → committed，意图 done、资源已放
    const result = journal.result!, report = parseCommand({ ...centralEnvelope(ctx), requestId: `result-${v2ObjectDigest(result)}`,
      type: "operation.result", payload: { result } });
    const lookup = await w.local.transport.receipt({ requestId: report.requestId, operationId: ctx.operationId, commandDigest: v2ObjectDigest(report) });
    expect(lookup).toMatchObject({ status: "committed", receipt: { command: "operation.result", result: { operationId: ctx.operationId } } });
    expect(intentRow(w, ctx.operationId).status).toBe("done");
    expect(held(w, ctx.operationId)).toEqual([]);
    evidence(w, "lost-receipt-merge", [{ item: `local:intent:${ctx.operationId}`, instance: "local",
      local: { journal: journal.state, result: result.state, ghCalls: w.ghCalls().length }, center: { lookup: lookup.status, intent: "done" } }]);
  });
});

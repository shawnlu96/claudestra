/**
 * dispatch-recovery-MODELXW 验收线 3：modelOutcome on 时，审查员回合的提供方策略拒审监护让路——同一个 pass 里监护先跑、auto tick 后跑
 * （scheduler-pass.ts 的顺序，auto tick 套 withSupervisorHold），拒审走到 MODELX 的 epoch，不发恢复消息、不退人工；observe / off 监护照旧。
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import { withSupervisorHold } from "../src/lib/agent-supervisor-hold.js";
import { recordSupervise } from "../src/lib/agent-supervisor-ledger.js";
import { CYBER_RECOVERY_TEXT, HOUR_MS, refusalYieldsToModel, type WorkRef } from "../src/lib/agent-supervisor-policy.js";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef, schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { refusalBypassesHold, setModelOutcomeReader } from "../src/lib/scheduler-model-wiring.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const CYBER = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";
const CONFIG: SchedulerConfig = {
  enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } },
};
const REGISTRY: RegistryAgent[] = [
  { name: "agent-task-one", channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" },
  { name: "agent-rv-t1", channelId: "ch-rv", sessionId: "s-rv", projectId: "p", runtime: "codex", transport: "acp", status: "active" },
];

const dir = mkdtempSync(join(tmpdir(), "modelxw-sup-"));
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxwSup, manualAfterMs: null }; }\n");
const g = globalThis as { __modelxwSup?: string };
let f: F;
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  f = autoFixture();
  writeFileSync(join(f.dir, "T1.md"), "# T1\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxwSup; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The review goes out; the reviewer's Codex turn is cut by cyber_policy and the bridge opens its「Codex 回合失败」card. */
async function reviewCut(): Promise<void> {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  const send = async () => {
    const claimed = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE status = 'submitted'").get() as { updatedAt: number }).updatedAt;
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败", context: CYBER,
      extra: { failure: "error", failedAt: claimed + 1, sessionId: "s-rv" } }, claimed + 1); // the bridge's card names the failed turn
    return { ok: true as const, messageId: "m" };
  };
  f.tickDeps.worker = () => createAcpWorker({
    sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
    ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
    port: { prompt: send, turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }), cancel: async () => ({ ok: true, evidence: "c" }) } });
  expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
}

/** One scheduler pass as scheduler-pass.ts runs it: the supervisor first, then the auto tick behind withSupervisorHold. */
function pass() {
  let now = 10 * HOUR_MS;
  const log = { sends: [] as string[], escalations: [] as string[] };
  const deps: SuperviseDeps = {
    registry: () => REGISTRY, calls: () => [], held: () => undefined, probe: async () => "running", activity: () => null, overload: () => ({}),
    record: async (rec) => {
      try { return { ok: true, duplicate: recordSupervise(f.db, { actor: "scheduler", now }, rec).duplicate }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    send: async (_a, _s, text) => (log.sends.push(text), { ok: true }),
    restart: async () => ({ ok: true }),
    escalate: async (taskId, intentId, reason) => {
      const r = await f.cli("scheduler", "scheduler-fallback-manual", taskId, "--reason", reason, "--intent", intentId);
      if (r.ok !== true) throw new Error(String(r.error));
      log.escalations.push(reason);
    },
    notifyCaller: async () => {}, notifyOwner: async () => {}, now: () => now, log: () => {},
  };
  const sup = new AgentSupervisor(() => {});
  const run = async () => {
    now += 31_000;
    const supervised = await sup.tick(f.db, CONFIG, deps);
    const auto = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, withSupervisorHold(f.tickDeps, f.db));
    return { supervised: supervised.outcomes, card: auto.cards[0], failed: [...supervised.failed, ...auto.failed] };
  };
  return { run, log };
}
const supervise = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "supervise");

describe("modelOutcome on：审查员策略拒审让给 MODELX", () => {
  test("同一个 pass：监护不认领、不发恢复消息；auto tick 记模型结果 → epoch，不退人工", async () => {
    g.__modelxwSup = "on";
    await reviewCut();
    const p = pass();
    const r = await p.run();
    expect(r.failed).toEqual([]);
    expect(r.supervised.filter((o) => o.step === "recover" || o.step === "report")).toEqual([]);
    expect(p.log.sends).toEqual([]);
    expect(supervise()).toEqual([]);
    expect(r.card).toMatchObject({ step: "refusal_epoch" });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap" && e.data.refusal)).toHaveLength(1);
    expect(p.log.escalations).toEqual([]);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect(f.notices.filter((n) => n.includes("退回人工"))).toEqual([]);
    // 下一轮：监护仍不碰这张卡
    await p.run();
    expect(p.log.sends).toEqual([]);
    expect(p.log.escalations).toEqual([]);
  });
});

describe("observe / off：监护行为不变", () => {
  for (const mode of ["observe", "off"] as const) {
    test(`${mode}：监护同会话发恢复消息，auto tick 让开`, async () => {
      g.__modelxwSup = mode;
      await reviewCut();
      const p = pass();
      const r = await p.run();
      expect(r.supervised).toEqual([{ agent: "agent-rv-t1", step: "recover", detail: "第 1 次恢复消息已发" }]);
      expect(p.log.sends).toEqual([CYBER_RECOVERY_TEXT]);
      expect(r.card).toMatchObject({ step: "waiting" });
      expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap")).toEqual([]);
    });
  }
});

test("让路只限 on + 调度单审查回合 + 策略拒审：作者回合、请求、额度 / 登录 / 存活都不让", () => {
  const review: WorkRef = { kind: "order", taskId: "T1", intentId: "i", step: "review" };
  const build: WorkRef = { kind: "order", taskId: "T1", intentId: "i", step: "build" };
  const call: WorkRef = { kind: "call", caller: "a", callerChannelId: "c", since: 1 };
  expect(refusalYieldsToModel(review, "cyber", "on")).toBe(true);
  expect(refusalYieldsToModel(review, "cyber", "observe")).toBe(false);
  expect(refusalYieldsToModel(review, "cyber", "off")).toBe(false);
  expect(refusalYieldsToModel(build, "cyber", "on")).toBe(false);
  expect(refusalYieldsToModel(call, "cyber", "on")).toBe(false);
  for (const fault of ["quota", "auth", "dead", "stuck", "overload"] as const) expect(refusalYieldsToModel(review, fault, "on")).toBe(false);
});

describe("MODELXW r2：observe 时监护留下的恢复认领，切 on 后不再挡住 MODELX（上轮 supervisor-held-refusal）", () => {
  test("observe 一轮：监护认领恢复、auto tick 让开；切 on：同一张拒审卡交给 MODELX → epoch，不发新恢复消息、不退人工", async () => {
    g.__modelxwSup = "observe";
    await reviewCut();
    const p = pass();
    const first = await p.run();
    expect(first.supervised).toEqual([{ agent: "agent-rv-t1", step: "recover", detail: "第 1 次恢复消息已发" }]);
    expect(first.card).toMatchObject({ step: "waiting" });
    expect(supervise().length).toBeGreaterThan(0); // 认领是台账事实，重启也还在
    g.__modelxwSup = "on";
    const r = await p.run();
    expect(r.failed).toEqual([]);
    expect(r.card).toMatchObject({ step: "refusal_epoch" }); // 旧代码：认领把失败改成 running，永远 waiting，MODEL 看不到拒审
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap" && e.data.refusal)).toHaveLength(1);
    expect(p.log.sends).toEqual([CYBER_RECOVERY_TEXT]); // 只有 observe 时那一条，on 下不再同模型重试
    expect(p.log.escalations).toEqual([]);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect(f.notices.filter((n) => n.includes("退回人工"))).toEqual([]);
  });

  test("observe 下认领照旧挡着：连续几轮都等恢复后的那一轮，不退人工、不记 epoch", async () => {
    g.__modelxwSup = "observe";
    await reviewCut();
    const p = pass();
    for (let i = 0; i < 3; i++) expect((await p.run()).card).toMatchObject({ step: "waiting" });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap")).toEqual([]);
    expect(p.log.escalations).toEqual([]);
  });

  test("绕过只限 on + 审查员回合 + 提供方策略拒审：作者回合、别的失败、observe / off 都照旧走监护 hold", async () => {
    g.__modelxwSup = "on";
    const reviewer = { taskId: "T1", role: "reviewer" as const, agent: "agent-rv-t1", sessionId: "s-rv", family: "codex" as const, transport: "acp" as const };
    const failed = (message: string) => ({ state: "result" as const, outcome: "failed" as const, failure: { kind: "error" as const, message } });
    expect(await refusalBypassesHold(f.db, reviewer, failed(CYBER))).toBe(true);
    expect(await refusalBypassesHold(f.db, reviewer, failed("This request violates our Usage Policy"))).toBe(true);
    expect(await refusalBypassesHold(f.db, { ...reviewer, role: "author" }, failed(CYBER))).toBe(false);
    expect(await refusalBypassesHold(f.db, reviewer, failed("socket hang up"))).toBe(false);
    expect(await refusalBypassesHold(f.db, reviewer, { state: "unknown", reason: "x", failure: { kind: "error", message: CYBER } })).toBe(false);
    for (const mode of ["observe", "off"]) {
      g.__modelxwSup = mode;
      expect(await refusalBypassesHold(f.db, reviewer, failed(CYBER))).toBe(false);
    }
  });
});

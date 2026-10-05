/**
 * 回合失败卡的受众判定（lib/runtime-failure-audience.ts）在真实台账 / registry / 出借 journal 文件上：只认台账绑定、在途的调度单，且宿主帧报的
 * 会话 / 失败时刻证明失败属于这张单；出借 worker 只在出借服务认得这次失败（lend-turn-failure.ts，停单回执借入方）时 quiet。
 * 退人工、已交、迟到的旧帧、出借服务认不了的失败、读不出来（含 registry 损坏）都照原路推 owner。
 * 监护恢复次数用完后仍由派活方接手。
 * 整条接线（onAcpFrame → ask → 推送 → 调度退人工）见 tests/runtime-failure-audience-wiring.test.ts。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureCardQuiet, type BridgeView } from "../src/lib/agent-supervisor-bridge.js";
import { recordSupervise } from "../src/lib/agent-supervisor-ledger.js";
import type { Supervised } from "../src/lib/agent-supervisor-scope.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { audienceView, dispatchedFailureQuiet, failureAudience, setFailureAudienceViewForTest } from "../src/lib/runtime-failure-audience.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); setFailureAudienceViewForTest(undefined); });

/** 跑到审查单已认领、发给 agent-rv-t1；审查员在 registry 里登记频道 ch-rv、项目 p */
async function atReview() {
  const f = autoFixture();
  cleanup.push(() => f.close());
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  Object.assign(reg.agents["agent-rv-t1"], { channelId: "ch-rv", projectId: "p" });
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await f.tick(); await f.tick();
  await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
  await f.cli("pm", "restate-approve", "T1");
  await f.tick(); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  const lend = join(f.dir, "lend.sqlite");
  const view = audienceView({ registry: f.registryPath, ledger: join(f.dir, "ledger.sqlite"), lend });
  return { f, view, lend };
}

/** 当前会话、现在失败：新宿主的帧 */
const NOW = () => ({ sessionId: "s-rv", failedAt: Date.now() });

test("在途的审查单：quiet；退回人工、已交了结论之后：照原路推", async () => {
  const { f, view } = await atReview();
  expect(failureAudience("ch-rv", NOW(), view)).toMatchObject({ quiet: true, who: "agent-rv-t1", why: expect.stringContaining("T1 reviewer") });
  expect(failureAudience("ch-unknown", NOW(), view)).toEqual({ quiet: false });

  f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'").run();
  expect(failureAudience("ch-rv", NOW(), view)).toEqual({ quiet: false });
  f.db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'").run();

  await f.review("pass", H1, []);
  expect(failureAudience("ch-rv", NOW(), view)).toEqual({ quiet: false }); // 已交：之后的失败不归这张单
});

test("归属证明不了：老宿主不报会话 / 时刻、别的会话、早于本单认领的迟到帧，都照原路推", async () => {
  const { view } = await atReview();
  expect(failureAudience("ch-rv", {}, view)).toEqual({ quiet: false });
  expect(failureAudience("ch-rv", { sessionId: "s-rv" }, view)).toEqual({ quiet: false });
  expect(failureAudience("ch-rv", { sessionId: "s-old", failedAt: Date.now() }, view)).toEqual({ quiet: false });
  expect(failureAudience("ch-rv", { sessionId: "s-rv", failedAt: 1 }, view)).toEqual({ quiet: false });
  expect(failureAudience("ch-rv", { sessionId: "s-rv", failedAt: Number.NaN }, view)).toEqual({ quiet: false });
  expect(failureAudience("ch-rv", NOW(), view).quiet).toBe(true);
});

test("出借 worker：出借服务认得这次失败（本单开跑后、会话对得上、之后没再开回合）才 quiet；认不了 / 读不出来照原路推并留诊断", async () => {
  const { f, view, lend } = await atReview();
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-lend-aa"] = { runtime: "codex", transport: "acp", sessionId: "s-l", channelId: "ch-l", kind: "worker" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const j = openLendJournal(lend);
  cleanup.push(() => j.close());
  const started = Date.now() - 60_000;
  j.query(`INSERT INTO lend_orders (orderId, peer, fp, family, state, preview, agent, sessionId, startedAt, createdAt, updatedAt)
    VALUES ('lend:o:s1:r0:a0', 'peer:A', NULL, 'codex', 'started', '{}', 'agent-lend-aa', 's-l', ?, 1, 1)`).run(started);
  const dir = mkdtempSync(join(tmpdir(), "rtf-rollout-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const rollout = join(dir, "r.jsonl");
  const turnAt = (at: number) => writeFileSync(rollout, `${JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type: "task_started" } })}\n`);
  const v = { ...view, sessionPath: (id: string) => (id === "s-l" ? rollout : null) };
  turnAt(started + 10_000);
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 20_000 }, v)).toMatchObject({ quiet: true, who: "agent-lend-aa" });
  // 失败之后又开过回合 / 早于本单开跑 / 找不到 rollout：出借服务不停单 → 照推，留诊断
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 5_000 }, v)).toMatchObject({ quiet: false, diag: expect.stringContaining("新回合") });
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started - 1 }, v)).toMatchObject({ quiet: false, diag: expect.stringContaining("开跑之前") });
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 20_000 }, { ...v, sessionPath: () => null })).toMatchObject({ quiet: false, diag: expect.stringContaining("rollout") });
  // 老宿主不报 / 会话对不上 / journal 不在跑 / 名字像但 registry 不是 worker：照推
  expect(failureAudience("ch-l", {}, v)).toEqual({ quiet: false });
  expect(failureAudience("ch-l", { sessionId: "s-x", failedAt: started + 20_000 }, v)).toEqual({ quiet: false });
  j.query("UPDATE lend_orders SET state = 'result_pending'").run();
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 20_000 }, v)).toEqual({ quiet: false });
  j.query("UPDATE lend_orders SET state = 'started'").run();
  delete reg.agents["agent-lend-aa"].kind;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 20_000 }, v)).toEqual({ quiet: false });
  reg.agents["agent-lend-aa"].kind = "worker";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  // journal 读坏：不 quiet、留诊断
  expect(failureAudience("ch-l", { sessionId: "s-l", failedAt: started + 20_000 }, { ...v, lendOrder: () => { throw new Error("journal locked"); } }))
    .toMatchObject({ quiet: false, diag: expect.stringContaining("journal locked") });
});

test("读不出来：不 quiet、留诊断，接线照原路推 owner", async () => {
  const { view } = await atReview();
  const broken = { ...view, ledger: () => { throw new Error("ledger locked"); } };
  expect(failureAudience("ch-rv", NOW(), broken)).toMatchObject({ quiet: false, diag: expect.stringContaining("ledger locked") });
  setFailureAudienceViewForTest(broken);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(dispatchedFailureQuiet("ch-rv", NOW())).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("ledger locked");
  } finally { warn.mockRestore(); }
});

test("registry 先读成功、再损坏：不拿上次成功的缓存当本次核验，不 quiet、留诊断", async () => {
  const { f, view } = await atReview();
  readRegistryAgentsSync(f.registryPath); // 让进程里的通用读者也有一份上次成功值
  expect(failureAudience("ch-rv", NOW(), view).quiet).toBe(true);
  writeFileSync(f.registryPath, "{ not json");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(readRegistryAgentsSync(f.registryPath).some((a) => a.channelId === "ch-rv")).toBe(true); // 通用读者仍回缓存（不改它）
    expect(failureAudience("ch-rv", NOW(), view)).toMatchObject({ quiet: false, diag: expect.stringContaining("registry 读不出来") });
  } finally { err.mockRestore(); }
});

test("监护恢复次数用完（failureCardQuiet = false）后，派单会话的失败仍由派活方接手、不推 owner", async () => {
  const { f, view } = await atReview();
  const CYBER = "This content was flagged for possible cybersecurity risk.";
  const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
  const rv: Supervised = { agent: "agent-rv-t1", channelId: "ch-rv", sessionId: "s-rv", project: "p", runtime: "codex", transport: "acp",
    work: { kind: "order", taskId: "T1", intentId: "i-1", step: "review" } };
  const sv: BridgeView = { config: () => config, supervised: () => [rv], db: () => f.db };
  const now = Date.now();
  recordSupervise(f.db, { actor: "scheduler", now }, { agent: "agent-rv-t1", project: "p", target: "T1", sessionId: "s-rv", fault: "cyber",
    faultKey: "ask_1", workKey: "order:i-1", step: "recover", phase: "claim", attempt: 1, limit: 1 });
  expect(failureCardQuiet("agent-rv-t1", CYBER, now, sv)).toBe(false);
  expect(failureAudience("ch-rv", NOW(), view).quiet).toBe(true);
});

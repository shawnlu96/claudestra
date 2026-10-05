/**
 * 回合失败卡的受众判定（lib/runtime-failure-audience.ts）在真实台账 / registry / 出借 journal 文件上：只认台账绑定、在途的调度单和
 * journal 里在跑的出借单；退人工、已交、读不出来都照原路推 owner（读不出来留诊断）。监护恢复次数用完后仍由派活方接手。
 * 整条接线（onAcpFrame → ask → 推送 → 调度退人工）见 tests/runtime-failure-audience-wiring.test.ts。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureCardQuiet, type BridgeView } from "../src/lib/agent-supervisor-bridge.js";
import { recordSupervise } from "../src/lib/agent-supervisor-ledger.js";
import type { Supervised } from "../src/lib/agent-supervisor-scope.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { audienceView, dispatchedFailureQuiet, failureAudience, setFailureAudienceViewForTest } from "../src/lib/runtime-failure-audience.js";
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

test("在途的审查单：quiet；退回人工、已交了结论之后：照原路推", async () => {
  const { f, view } = await atReview();
  expect(failureAudience("ch-rv", view)).toMatchObject({ quiet: true, who: "agent-rv-t1", why: expect.stringContaining("T1 reviewer") });
  expect(failureAudience("ch-unknown", view)).toEqual({ quiet: false });

  f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'").run();
  expect(failureAudience("ch-rv", view)).toEqual({ quiet: false });
  f.db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'").run();

  await f.review("pass", H1, []);
  expect(failureAudience("ch-rv", view)).toEqual({ quiet: false }); // 已交：之后的失败不归这张单
});

test("出借 worker：kind=worker + journal 在跑 + 会话一致才 quiet；单结束了 / 不是 worker 都不算", async () => {
  const { f, view, lend } = await atReview();
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-lend-aa"] = { runtime: "codex", transport: "acp", sessionId: "s-l", channelId: "ch-l", kind: "worker" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(failureAudience("ch-l", view)).toEqual({ quiet: false }); // journal 还不在
  const j = openLendJournal(lend);
  cleanup.push(() => j.close());
  j.query(`INSERT INTO lend_orders (orderId, peer, fp, family, state, preview, agent, sessionId, createdAt, updatedAt)
    VALUES ('lend:o:s1:r0:a0', 'peer:A', NULL, 'codex', 'started', '{}', 'agent-lend-aa', 's-l', 1, 1)`).run();
  expect(failureAudience("ch-l", view)).toMatchObject({ quiet: true, why: expect.stringContaining("lend:o:s1:r0:a0") });
  j.query("UPDATE lend_orders SET state = 'stopped'").run();
  expect(failureAudience("ch-l", view)).toEqual({ quiet: false });
  j.query("UPDATE lend_orders SET state = 'result_pending'").run();
  expect(failureAudience("ch-l", view).quiet).toBe(true);
  reg.agents["agent-lend-aa"].kind = "main";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(failureAudience("ch-l", view)).toEqual({ quiet: false });
});

test("读不出来：不 quiet、留诊断，接线照原路推 owner", async () => {
  const { f, view, lend } = await atReview();
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-lend-aa"] = { runtime: "codex", transport: "acp", sessionId: "s-l", channelId: "ch-l", kind: "worker" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  writeFileSync(lend, "not a sqlite file");
  const a = failureAudience("ch-l", view);
  expect(a).toMatchObject({ quiet: false, diag: expect.stringContaining("照原路推 owner") });

  const broken = { ...view, ledger: () => { throw new Error("ledger locked"); } };
  expect(failureAudience("ch-rv", broken)).toMatchObject({ quiet: false, diag: expect.stringContaining("ledger locked") });
  setFailureAudienceViewForTest(broken);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(dispatchedFailureQuiet("ch-rv")).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("ledger locked");
  } finally { warn.mockRestore(); }
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
  expect(failureAudience("ch-rv", view).quiet).toBe(true);
});

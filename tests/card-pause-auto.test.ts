/**
 * UXPAUSE1 · the auto tick's own ports (autoTickDeps' manager / notifyPm, apart from the pass manager) through the real scheduler
 * pass on a temp ledger, no shared mode file, cardPause on: a pause landing while the pass awaits the borrow list writes no plan and
 * sends no review; MAN2 does not hand a paused manual card back to auto; a refused-plan notice waiting for retry stays pending while
 * the card is paused and goes out after resume. Old red: each case wrote / sent while the card was paused (review round 1).
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureCardPausePolicy } from "../src/lib/card-pause.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { autoSource, pendingAutoEvents, sourceKey } from "../src/lib/memory-auto-common.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { sendNotice } from "../src/lib/scheduler-auto-tick.js";
import { DEFAULT_REMOTE, type SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type Fixture = ReturnType<typeof autoFixture>;
const cleanups: (() => void)[] = [];
afterEach(() => { configureCardPausePolicy(null); while (cleanups.length) cleanups.pop()!(); });
const policyOf = (cardPause: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "cardPause" ? cardPause : "off", manualAfterMs: null, source: "config" });
/** MAN2 reads the file-backed policy (the pass's guarded deps carry no recoveryPolicy port): the test run's temp state dir, restored after. */
function manualStallOn(f: Fixture) {
  const saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  cleanups.push(() => { if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved); else rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  return f.cli("pm", "scheduler-recovery", "p", "on", "--key", "manualStall", "--reason", "UXPAUSE1 测试：manualStall on");
}

function config(dir: string, remote = false): SchedulerConfig {
  return { enabled: true, autoDispatch: true, pollMs: 1000, projects: { p: { repoDir: dir, maxActiveWorkers: 2, requiredChecks: ["ci"], mergeTrain: "off",
    ...(remote ? { remote: DEFAULT_REMOTE } : {}) } } };
}
function passOpts(f: Fixture): PassOpts {
  return { assertOwner: () => {}, maintenance: { path: join(f.dir, "maintenance"), marker: join(f.dir, "marker"), request: join(f.dir, "request") },
    trainTick: async () => {}, peerPr: async () => ({ failed: [] }), autostart: () => ({ start: async () => [], resume: async () => [] }),
    lockYield: async () => [], retire: async () => [], lifecycle: async () => [], manager: f.tickDeps.manager, autoDeps: () => f.tickDeps };
}
function consumeMemoryBacklog(db: Database) {
  for (const e of pendingAutoEvents(db, "p", 100)) {
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1,'scheduler','p',?,'memory','','{}',?)")
      .run(e.target, `memory-auto:p:${sourceKey(autoSource(e))}`);
  }
}
async function pass(f: Fixture, n = 1, remote = false) {
  for (let i = 0; i < n; i++) {
    consumeMemoryBacklog(f.db);
    const r = await schedulerPass(f.db, config(f.dir, remote), passOpts(f));
    expect(r.failed).toEqual([]);
  }
}
function fixture(cardPause: RecoveryMode): Fixture {
  const f = autoFixture();
  cleanups.push(f.close);
  configureCardPausePolicy(policyOf(cardPause));
  const quiet = [spyOn(console, "info").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  cleanups.push(() => quiet.forEach((s) => s.mockRestore()));
  return f;
}
async function atReview(f: Fixture): Promise<Fixture> {
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  return f;
}
const pause = (f: Fixture) => f.cli("pm", "card-pause", "T1", "--reason", "PM 核对") as Promise<Record<string, any>>;
const resume = (f: Fixture) => f.cli("pm", "card-resume", "T1");
const topSeq = (db: Database) => (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
const t1Writes = (db: Database, after: number) => (db.query("SELECT kind, data FROM events WHERE target = 'T1' AND seq > ? ORDER BY seq").all(after) as
  { kind: string; data: string }[]).filter((e) => e.kind !== "memory").map((e) => `${e.kind}:${JSON.parse(e.data).op ?? ""}`);

describe("[验收线 1] the auto tick's own manager is held for a paused card", () => {
  test("a pause landing while the pass awaits the borrow list: no plan, no snapshot, no settle, no review order", async () => {
    const f = await atReview(fixture("on"));
    const sentBefore = f.sent.length;
    let seq = 0;
    f.tickDeps.borrow = async () => {
      expect((await pause(f)).ok).toBe(true); // after the candidate loop's skipTask, before any plan for this round
      seq = topSeq(f.db);
      return [];
    };
    await pass(f, 1, true);
    expect(seq).toBeGreaterThan(0);
    expect(t1Writes(f.db, seq)).toEqual([]);
    expect(f.sent.length).toBe(sentBefore);
    expect(f.intents().filter((i) => i.action === "review")).toEqual([]);
    delete f.tickDeps.borrow;
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 2, true);
    expect(f.intents().at(-1)).toMatchObject({ action: "review" });
    expect(f.sent.map((s) => s.agent)).toContain("agent-rv-t1");
  });

  test("MAN2 does not hand a paused manual card back to auto, sends no PM notice; resume lets it recover", async () => {
    const f = fixture("on");
    expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
    expect(await manualStallOn(f)).toMatchObject({ ok: true });
    createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
    addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
    const wf = () => getWorkflow(f.db, "T1")!;
    expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf().rev), "--template", wf().template,
      "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "deps_not_live", "--reason", "等 T0 上线"))
      .toMatchObject({ ok: true });
    for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const) {
      moveStage(f.db, f.at("owner"), { taskId: "T0", from, to });
    }
    recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
    expect((await pause(f)).ok).toBe(true);
    const before = { mode: wf().mode, rev: wf().rev }, seq = topSeq(f.db);
    await pass(f, 3);
    expect({ mode: wf().mode, rev: wf().rev }).toEqual(before);
    expect(f.notices).toEqual([]);
    expect(t1Writes(f.db, seq)).toEqual([]);
    expect((await resume(f)).ok).toBe(true);
    await pass(f);
    expect(wf()).toMatchObject({ mode: "auto", rev: before.rev + 1 });
    expect(f.notices.some((n) => n.includes("manual 自动恢复"))).toBe(true);
  });
});

describe("[验收线 1] a refused-plan notice waiting for retry is not sent for a paused card", () => {
  test("pending notice stays while paused (several passes, notice port healthy), goes out once after resume", async () => {
    const f = await atReview(fixture("on"));
    const key = "T1\ninvalid\n测试拒收";
    const down = { ...f.tickDeps, notifyPm: async () => { throw new Error("通知端口暂时不可用"); } };
    expect(await sendNotice(f.db, down, key, { task: f.task(), text: "[调度引擎] T1 的调度计划连续 3 次被台账拒收" })).toBe(false);
    expect((await pause(f)).ok).toBe(true);
    await pass(f, 3);
    expect(f.notices).toEqual([]);
    expect((await resume(f)).ok).toBe(true);
    await pass(f);
    expect(f.notices.filter((n) => n.includes("连续 3 次被台账拒收"))).toHaveLength(1);
    await pass(f);
    expect(f.notices.filter((n) => n.includes("连续 3 次被台账拒收"))).toHaveLength(1);
  });
});

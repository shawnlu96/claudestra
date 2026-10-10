/**
 * dispatch-recovery-MAN2: a deploy whose outcome is not settled keeps a deps-bound manual card manual until the formal exit closes it.
 * The whole chain runs through the formal entries on a real temp ledger — the auto tick takes the card through review to the merge
 * queue, the scheduler identity drives merge and deploy journals (scheduler-merge-* / scheduler-deploy-*), the PM puts the card manual
 * with a coded reason (workflow-set), cancels nothing by hand and settles the unknown deploy with scheduler-merge-resolve. No SQL writes
 * on the state under test, no engine ack or verdict forged. Each unsettled phase: tick → zero resumes / intents / sends / sessions;
 * after resolveDeployRun: exactly one workflow_resume, and the settled merge / deploy are never re-run.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { manualResumeVerdict } from "../src/lib/manual-resume.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { autoFixture, H2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const PR = "https://github.com/example/repo/pull/9", MERGE = "9".repeat(40), LABEL = `com.claudestra.scheduler.deploy.${"a".repeat(32)}`;

let saved: Buffer | null = null;
beforeEach(() => {
  expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
  saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  rmSync(RECOVERY_POLICY_PATH, { force: true });
});
afterEach(() => {
  if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
});

const wf = (f: F) => getWorkflow(f.db, "T1")!;
const ops = (f: F, op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
/** Everything a resume, a dispatch or a re-run merge / deploy would change. */
const effects = (f: F) => ({
  intents: f.db.query("SELECT id, action, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  merges: f.db.query("SELECT intentId, phase, rev FROM scheduler_merges ORDER BY intentId").all(),
  deploys: f.db.query("SELECT intentId, phase, rev FROM scheduler_deploys ORDER BY intentId").all(),
  workflow: f.db.query("SELECT mode, rev FROM task_workflows WHERE taskId = 'T1'").get(),
  stage: f.task().stage, sent: f.sent.length, ensured: f.ensured.length, resumes: ops(f, "workflow_resume").length,
});
const sch = (f: F, ...args: string[]) => f.cli("scheduler", ...args);

/** The real auto tick takes T1 through build and review to the merge queue; the scheduler claims and merges through the journal. */
async function mergedT1(f: F): Promise<string> {
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "task-set", "T1", "--rev", String(f.task().rev), "--branch", "task/T1", "--pr", PR)).toMatchObject({ ok: true });
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  await f.tick();
  await f.tick();
  expect(await f.review("pass", H2, [])).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
  expect(await sch(f, "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await sch(f, "scheduler-merge-begin", id, "--required-checks", "ci")).toMatchObject({ ok: true, run: { phase: "ready" } });
  const step = (from: string, to: string, rev: number, ...extra: string[]) =>
    sch(f, "scheduler-merge-step", id, "--from", from, "--to", to, "--rev", String(rev), "--receipt", `${from}→${to}`, ...extra);
  expect(await step("ready", "await_ci", 1)).toMatchObject({ ok: true });
  expect(await step("await_ci", "merging", 2)).toMatchObject({ ok: true });
  expect(await step("merging", "merged", 3, "--merge-sha", MERGE)).toMatchObject({ ok: true, run: { phase: "merged" } });
  return id;
}

/** Each refusal names the open deploy (or the hold in front of it) and a full on tick changes nothing. */
async function holds(f: F, why: string): Promise<void> {
  expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining(why) });
  const before = effects(f);
  await f.tick();
  await f.tick();
  expect(effects(f)).toEqual(before);
}

/** T1's deploy is claimed when the PM parks it on T0 (MAN1 coded entry); T0 is then really verified and manualStall is on. */
async function parked(f: F): Promise<string> {
  createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
  const id = await mergedT1(f);
  expect(await sch(f, "scheduler-deploy-begin", id)).toMatchObject({ ok: true, run: { phase: "claimed" } });
  addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
  expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--template", "code", "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "deps_not_live", "--reason", "等 T0 上线")).toMatchObject({ ok: true });
  for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const) {
    moveStage(f.db, f.at("owner"), { taskId: "T0", from, to });
  }
  recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
  expect(await f.cli("pm", "scheduler-recovery", "p", "on", "--key", "manualStall", "--reason", "MAN2 测试：manualStall on")).toMatchObject({ ok: true });
  return id;
}
const toRunning = async (f: F, id: string) =>
  expect(await sch(f, "scheduler-deploy-step", id, "--from", "claimed", "--to", "running", "--rev", "1", "--label", LABEL)).toMatchObject({ ok: true });
const toUnknown = async (f: F, id: string) =>
  expect(await sch(f, "scheduler-deploy-step", id, "--from", "running", "--to", "unknown", "--rev", "2", "--outcome", "unknown", "--liveness", "dead",
    "--receipt", "result.json 缺失")).toMatchObject({ ok: true, run: { phase: "unknown" } });
const unfreeze = async (f: F) => expect(await f.cli("pm", "unfreeze", "--project", "p", "--text", "MAN2 测试：PM 核对后解冻")).toMatchObject({ ok: true });
const RESOLVE = (id: string) => ["scheduler-merge-resolve", id, "--outcome", "done", "--receipt", "看过 launchd 日志与线上版本，部署已完成"];

/** One on tick after the formal settle: exactly one scheduler workflow_resume bound to the entry, one PM note, the journals untouched. */
async function resumesOnce(f: F, id: string): Promise<void> {
  const settled = effects(f);
  expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: true });
  await f.tick();
  const ev = ops(f, "workflow_resume");
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ actor: "scheduler", data: { op: "workflow_resume", from: "manual", auto: true,
    manualResume: { code: "deps_not_live", deps: [{ id: "T0", stage: "verified" }] } } });
  expect(f.notices.filter((n) => n.includes("manual 自动恢复"))).toHaveLength(1);
  const after = effects(f);
  expect({ merges: after.merges, deploys: after.deploys, sent: after.sent, ensured: after.ensured })
    .toEqual({ merges: settled.merges, deploys: settled.deploys, sent: settled.sent, ensured: settled.ensured });
  expect(getMergeRun(f.db, id)).toMatchObject({ phase: "merged" });
  expect(getDeployRun(f.db, id)).toMatchObject({ phase: "resolved" });
}

test("claimed / running / unknown stay manual; the PM's resolveDeployRun settles the intent, then exactly one resume and no re-run", async () => {
  const f = autoFixture();
  try {
    const id = await parked(f);
    await holds(f, `${id}:submitted`); // the merge intent holds the slot while the deploy is claimed …
    await toRunning(f, id);
    await holds(f, `${id}:submitted`); // … and running
    expect(getDeployRun(f.db, id)?.phase).toBe("running");
    await toUnknown(f, id);
    await holds(f, "项目合并队列冻结");
    const resolve = RESOLVE(id);
    expect(await sch(f, ...resolve)).toMatchObject({ ok: false, code: "forbidden" }); // never the scheduler
    await holds(f, "项目合并队列冻结");
    expect(await f.cli("pm", ...resolve)).toMatchObject({ ok: true, run: { phase: "resolved" } });
    expect(ops(f, "deploy_resolve")).toEqual([expect.objectContaining({ actor: "pm", data: expect.objectContaining({ outcome: "done", manual: true }) })]);
    expect(f.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(id)).toEqual({ status: "done" });
    await holds(f, "项目合并队列冻结"); // resolve leaves the queue frozen for the PM
    await unfreeze(f);
    await resumesOnce(f, id);
    expect(wf(f).mode).toBe("auto");
    expect(ops(f, "workflow_resume")[0].data.next).toMatchObject({ kind: "wait", code: "in_flight" }); // no new merge / deploy planned
    const resumed = effects(f);
    for (let i = 0; i < 3; i++) await f.tick(); // repeated passes: no second resume, no dispatch, merge / deploy journals untouched
    expect(effects(f)).toEqual(resumed);
  } finally { f.close(); }
});

test("cancelling the intent and unfreezing never settle a deploy; after resolve the resume is single and a cancelled merge is not retried", async () => {
  const f = autoFixture();
  try {
    const id = await parked(f);
    expect(await sch(f, "scheduler-settle", id, "--from", "submitted", "--to", "cancelled", "--receipt", "撤意图")).toMatchObject({ ok: true });
    await holds(f, `${id}:claimed`);
    await toRunning(f, id);
    await holds(f, `${id}:running`);
    await toUnknown(f, id);
    await holds(f, "项目合并队列冻结");
    await unfreeze(f);
    await holds(f, `${id}:unknown`);
    expect(ops(f, "deploy_resolve")).toHaveLength(0);
    expect(await f.cli("pm", ...RESOLVE(id))).toMatchObject({ ok: true, run: { phase: "resolved" } });
    await resumesOnce(f, id);
    // the resumed planner refuses to retry the cancelled merge and hands the card back with a sticky code MAN2 never lifts
    expect(ops(f, "fallback_manual").at(-1)).toMatchObject({ data: { manualReason: { code: "merge_unknown" } } });
    expect(wf(f).mode).toBe("manual");
    const parkedAgain = effects(f);
    for (let i = 0; i < 3; i++) await f.tick();
    expect(effects(f)).toEqual(parkedAgain);
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("merge_unknown") });
  } finally { f.close(); }
});

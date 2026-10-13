/**
 * MAINCIW fixture (no tests of its own; named *.test.ts to stay inside the card's file globs): a temporary ledger driven by the real
 * schedulerPass (train tick → mergeTick → driveMerge → auto tick through the real ledger CLI), GitHub faked twice over: the PR / train
 * side by the MTR1 fakeGitHub (tests/scheduler-merge-reclaim-world.ts) and main's own checks by a fake `gh api` command that the real
 * envelope reader (scheduler-main-ci-wiring-gh.ts) parses. The merge external carries the real main CI gate (withMainCi).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent, type EventDraft } from "../src/lib/ledger-tx.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { setMainCiPortsForTest, withMainCi } from "../src/lib/scheduler-main-ci-wiring-gate.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeTrainTick, withMergeTrain, type FormFence } from "../src/lib/scheduler-merge-train-tick.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { runLedger } from "../src/manager/ledger.js";
import { setMainCiCliForTest } from "../src/manager/ledger-main-ci-cmds.js";
import type { Registry } from "../src/manager/core.js";
import { fakeGitHub, memoryTrainStore } from "./scheduler-merge-reclaim-world.js";

let worlds = 0;
export type Ci = "success" | "failure" | "pending" | "missing";

export function writePolicy(keys: Record<string, RecoveryMode>) {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys } } }));
}

export function mainCiWorld() {
  const REPO = `example/mainciw-${++worlds}`;
  const dir = mkdtempSync(join(tmpdir(), "mainciw-")), path = join(dir, "ledger.sqlite");
  let db = openLedger(path);
  let reader = new LedgerReader(path);
  db.run("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', ?)", [JSON.stringify(["agent-pm"])]);
  const config = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });
  setForeignRepoLookupForTest({ origin: () => REPO.toLowerCase() });
  const cards: { taskId: string; prRef: string; head: string }[] = [];
  const idOf = (pr: string) => cards.find((c) => c.prRef === pr)!.taskId;
  const { hub, gh, base, newSha } = fakeGitHub({ name: idOf, branch: (pr) => `task/${idOf(pr)}`, files: (pr) => `src/${pr.split("/").pop()}.ts` });
  /** main's CI per sha (default `defaultCi`), the PR-head check bucket per card, and every main CI read `gh api` saw. */
  const ci = { bySha: new Map<string, Ci>(), defaultCi: "success" as Ci, reads: [] as string[], fail: false, mainOverride: null as (() => string) | null,
    prChecks: new Map<string, PrSnapshot["checks"][number]["bucket"]>(), onInspect: null as ((prRef: string) => Promise<void>) | null,
    onReceipt: null as ((args: string[]) => Promise<void>) | null }; // runs after the ledger wrote, before the receipt reaches the caller
  const json = (v: unknown): BoundedResult => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false });
  const command = async (argv: string[]): Promise<BoundedResult> => {
    const p = argv.at(-1)!;
    ci.reads.push(p);
    if (ci.fail) return { code: 1, stdout: "", stderr: "HTTP 502", timedOut: false };
    if (p.endsWith("/git/ref/heads/main")) return json({ ref: "refs/heads/main", object: { type: "commit", sha: ci.mainOverride?.() ?? hub.main } });
    const sha = /commits\/([a-f0-9]{40})\//.exec(p)![1]!, state = ci.bySha.get(sha) ?? ci.defaultCi;
    if (p.includes("/check-runs")) {
      const runs = state === "missing" ? [] : [{ id: 1, name: "check", head_sha: sha, status: state === "pending" ? "in_progress" : "completed",
        conclusion: state === "pending" ? null : state }];
      return json({ total_count: runs.length, check_runs: runs });
    }
    return json({ sha, total_count: 0, statuses: [] });
  };
  const clock = { now: Date.now(), jumpOnChecks: 0 };
  const notices: string[] = [];
  setMainCiPortsForTest({ command: async (argv, o) => {
    if (argv.at(-1)!.includes("/check-runs")) clock.now += clock.jumpOnChecks;
    return command(argv as string[]);
  }, notify: async (project, text) => { notices.push(`${project}: ${text}`); }, now: () => clock.now });
  const target = () => ({ project: "p", repo: REPO.toLowerCase(), requiredChecks: ["check"] });
  setMainCiCliForTest({ target: (p) => (p === "p" ? target() : null), command: async (argv) => command(argv as string[]), now: () => clock.now });

  let num = 0;
  /** An auto code card at `stage` with a passing cross-family review on a fresh head (the MTR1 card, tests/scheduler-merge-reclaim-world.ts). */
  const card = (id: string, stage = "merge") => {
    const n = ++num, prRef = `https://github.com/${REPO}/pull/${n}`, head = newSha(), at = Date.now();
    createTask(db, { actor: "owner", now: at }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
    setWorkflow(db, { actor: "owner", now: at }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage=?, round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(stage, head, prRef, `task/${id}`, at + n, id);
    const ev = (actor: string, kind: EventDraft["kind"], data: Record<string, unknown>, dedupKey?: string) =>
      insertEvent(db, { actor, now: at, dedupKey }, { project: "p", target: id, kind, text: "", data }, !!dedupKey).seq;
    ev("scheduler", "stage", { from: "build", to: "review", round: 1 });
    const intent = (iid: string, action: string, recipient: string | null) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
      causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,recipient,createdAt,updatedAt) VALUES (?,?,'p','adversarial_review',?,1,?,1,1,?,2,
      'done','reviewer',?,?,?)`).run(iid, id, action, ev("scheduler", "scheduler", { op: "plan", intentId: iid }), head, recipient, at, at);
    intent(`rc-${id}`, "ensure_session", null);
    intent(`rv-${id}`, "review", "agent-review");
    ev("scheduler", "scheduler", { op: "intent_submitted", intentId: `rv-${id}` }, `scheduler:rv-${id}:submitted`);
    ev("agent-review", "review", { round: 1, head, verdict: "pass", reviewer: "agent-review", reviewerSessionId: `rs-${id}`, reviewerFamily: "codex",
      path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 });
    db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'reviewer','agent-review',?,'codex','acp','active',?,?,?)`).run(id, `rs-${id}`, `rc-${id}`, at, at);
    hub.heads.set(prRef, head); hub.synced.set(prRef, hub.main);
    const c = { taskId: id, prRef, head };
    cards.push(c);
    return c;
  };
  const memory = memoryTrainStore(), store = memory.store;
  const trainNotices: string[] = [];
  const ledger = (actor: string, args: string[]) => runLedger(args, { db, actor, projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true,
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
  const managerLog: string[][] = [];
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    managerLog.push(args);
    const r = args[1] === "verify" ? { ok: true, result: "pending" } : args[1] === "memory-auto" ? { ok: true } : await ledger("scheduler", args.slice(1));
    await ci.onReceipt?.(args);
    return r;
  };
  /** PR checks per card (`ci.prChecks`), else the fake's green check. */
  const inspect = async (prRef: string): Promise<PrSnapshot> => {
    await ci.onInspect?.(prRef);
    const pr = await base.inspect(prRef), b = ci.prChecks.get(idOf(prRef));
    return b ? { ...pr, mergeState: b === "fail" ? "UNSTABLE" : pr.mergeState, checks: [{ name: "check", bucket: b, link: "https://github.com/x/actions/runs/1/job/2" }] } : pr;
  };
  const external = (p: (typeof config)["projects"][string]): MergeExternal => withMainCi(withMergeTrain({ ...base, inspect }, { gh, store }), p);
  const autoDeps = () => ({ manager, now: Date.now, worker: () => ({ manual: "测试里不开会话" }), ensure: async () => { throw new Error("测试里不开会话"); },
    pinReview: async () => ({ manual: "x" }), reviewDirty: async () => null, notifyPm: async () => {}, prState: inspect });
  const noop = async () => ({ failed: [] });
  const mdirs: string[] = [];
  const pass = async (o: { reader?: LedgerReader } = {}) => {
    const before = hub.calls.length, m = mkdtempSync(join(tmpdir(), "mainciw-maint-"));
    mdirs.push(m);
    const trainTick = (d: typeof db, projects: readonly string[], _a: unknown, formFence?: FormFence) =>
      mergeTrainTick(d, projects, { now: Date.now, formFence, notifyPm: async (t, text) => { trainNotices.push(`${t.id}: ${text}`); } }, { gh, store }, () => ["check"]);
    const r = await schedulerPass((o.reader ?? reader).get()!, config, { assertOwner: () => {}, manager, cursor: {}, budgetMs: 60_000, trainTick, external,
      maintenance: { path: join(m, "m.lock"), marker: join(m, "u.marker"), request: join(m, "m.req") }, autoDeps: autoDeps as never, peerPr: noop,
      autostart: () => ({ resume: async () => [], start: async () => [] }), retire: async () => [], lifecycle: async () => [], train: { gh, store } });
    if (r.failed.length) hub.calls.push(...r.failed.map((f) => `failed:${f.taskId}:${f.error}`));
    return hub.calls.slice(before);
  };
  const intentOf = (id: string) => db.query(`SELECT id, status FROM scheduler_intents WHERE taskId=? AND action='merge' ORDER BY eventSeq DESC LIMIT 1`)
    .get(id) as { id: string; status: string } | null;
  const phase = (id: string) => { const i = intentOf(id); return i ? getMergeRun(db, i.id)?.phase ?? null : null; };
  const events = (id: string) => listEvents(db, { project: "p", target: id });
  const frozen = () => (db.query("SELECT value FROM meta WHERE project='p' AND key='queueFrozen'").get() as { value: string } | null)?.value.includes('"frozen":true') ?? false;
  /** A begun run at ready holding the slot, as the auto tick + mergeTick leave it (MTR1 begin). */
  const begin = async (id: string) => {
    const task = getTask(db, id)!, intent = `merge-${id}`;
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
      createdAt,updatedAt) VALUES (?,?,'p','merge_deploy','merge',3,2,?,1,?,2,'pending','merge',100,100)`).run(intent, id, task.rev, task.headSHA);
    db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,100)").run(id, intent);
    await manager("ledger", "scheduler-settle", intent, "--from", "pending", "--to", "submitted", "--receipt", "merge controller claimed");
    const r = await manager("ledger", "scheduler-merge-begin", intent, "--required-checks", "check");
    if (r.ok !== true) throw new Error(String(r.error));
    return intent;
  };
  const step = async (intent: string, from: string, to: string, receipt = "测试推进") => {
    const run = getMergeRun(db, intent)!;
    const r = await manager("ledger", "scheduler-merge-step", intent, "--from", from, "--to", to, "--rev", String(run.rev), "--receipt", receipt);
    if (r.ok !== true) throw new Error(String(r.error));
  };
  const restart = () => { reader.close(); closeLedger(path); db = openLedger(path); reader = new LedgerReader(path); };
  const close = () => {
    setMainCiPortsForTest(null); setMainCiCliForTest(null); setForeignRepoLookupForTest({ origin: null });
    reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true });
    for (const m of mdirs) rmSync(m, { recursive: true, force: true });
  };
  return { get db() { return db; }, path, hub, gh, ci, clock, notices, trainNotices, store, events: memory.events, managerLog, card, pass, begin, step, phase, intentOf,
    taskEvents: events, frozen, restart, close, ledger, repo: REPO.toLowerCase(), newSha };
}
export type MainCiWorld = ReturnType<typeof mainCiWorld>;

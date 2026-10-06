/**
 * MTR1 fixture: a temporary ledger driven by the real schedulerPass (train tick → mergeTick → deployTick → reclaim → auto tick,
 * whose merge planning goes through the real ledger CLI `scheduler-plan`), with GitHub and the deploy jobs faked. No network,
 * no launchctl. The train is formed and stepped only by the pass's own train tick: PassOpts.trainTick is the real mergeTrainTick
 * (real candidates and member outcomes from the ledger) with the fake gh, a PM-notice recorder and this world's required checks
 * in place of scheduler.json. `store`: "memory" / "file" are also injected through PassOpts.train; "default" injects no store,
 * so trainProjects / mergeTick / reclaim use defaultTrainStore() — only a non-test child process has one
 * (scheduler-merge-reclaim.test.ts runs this file as that child) — and the tick gets that same state-dir file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent, type EventDraft } from "../src/lib/ledger-tx.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { DEPLOY_LABEL_PREFIX } from "../src/lib/scheduler-deploy.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { TrainEvent, TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";
import { trainHolds } from "../src/lib/scheduler-merge-train-hold.js";
import { fileTrainStore, mergeTrainTick, withMergeTrain, type FormFence } from "../src/lib/scheduler-merge-train-tick.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

let worlds = 0; // a repo per world: the train tick caches PR file lists by PR URL and head for the whole process

/** handoff: scheduler.json mergeHandoff on (MHO1): the auto tick reads PRs from the same fake GitHub and hands them over. */
export interface WorldOpts { store: "memory" | "file" | "default"; deploy?: boolean; files?: (n: number) => string; handoff?: boolean }

/**
 * GitHub as the train and the merge driver see it (shared with scheduler-merge-train-hold.test.ts): one main that moves on each
 * merge, PR heads, a record of every update-branch / merge in order (`calls`, labelled by `name`). update-branch keeps the head.
 */
export function fakeGitHub(o: { name: (prRef: string) => string; branch: (prRef: string) => string; files: (prRef: string) => string;
  newSha?: () => string }) {
  let shaSeq = 0;
  const newSha = o.newSha ?? (() => (++shaSeq).toString(16).padStart(40, "0")); // one counter with the caller's card heads
  const hub = { main: newSha(), parents: new Map<string, string[]>(), heads: new Map<string, string>(), merged: new Map<string, string>(),
    synced: new Map<string, string>(), pending: false, calls: [] as string[],
    /** The service stops while this card's merge call is out (GitHub merged it or not): the journal stays at `merging`. */
    stopIn: null as { name: string; merged: boolean } | null };
  const mergeInto = (prRef: string, head: string, call: string) => {
    const stop = hub.stopIn?.name === o.name(prRef) ? hub.stopIn : null;
    if (stop) hub.stopIn = null;
    if (stop && !stop.merged) throw new SchedulerStopped("服务在合并调用途中停止");
    const sha = newSha();
    hub.parents.set(sha, [hub.main, head]); hub.main = sha; hub.merged.set(prRef, sha);
    hub.calls.push(`${call}:${o.name(prRef)}`);
    if (stop) throw new SchedulerStopped("服务在合并调用途中停止");
    return sha;
  };
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => [o.files(pr)],
    prHead: async (pr) => hub.heads.get(pr)!,
    createBranch: async () => {},
    mergeInto: async () => "merged",
    openDraft: async () => 1000,
    checks: async () => [{ name: "check", bucket: hub.pending ? "pending" : "pass" }],
    failLog: async () => "",
    parents: async (_r, sha) => hub.parents.get(sha) ?? [newSha()],
    mergeMatchHead: async (prRef, head) => mergeInto(prRef, head, "match-head"),
    closePr: async () => {},
    deleteBranch: async () => {},
  };
  const pr = (prRef: string): PrSnapshot => {
    const merged = hub.merged.get(prRef) ?? null;
    return { state: merged ? "MERGED" : "OPEN", head: hub.heads.get(prRef)!, branch: o.branch(prRef), base: "main", draft: false,
      crossRepository: false, mergeState: "CLEAN", mergeSha: merged, checks: [{ name: "check", bucket: "pass" }] };
  };
  const base: MergeExternal = {
    inspect: async (prRef) => pr(prRef),
    freshness: async (prRef) => ({ behindBy: hub.synced.get(prRef) === hub.main ? 0 : 1, mainHead: hub.main }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async (prRef) => { hub.synced.set(prRef, hub.main); hub.calls.push(`update:${o.name(prRef)}`); }, // head kept: a no-op merge of main
    merge: async (prRef, head) => mergeInto(prRef, head, "serial-merge"),
  };
  return { hub, gh, base, newSha };
}

/** A train store in memory, with the train events it was told. */
export function memoryTrainStore(): { store: TrainStore; events: TrainEvent[] } {
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  return { events, store: { load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 } };
}

export function reclaimWorld(opts: WorldOpts) {
  const REPO = `example/mtr1-${++worlds}`;
  const dir = mkdtempSync(join(tmpdir(), "mtr1-")), path = join(dir, "ledger.sqlite");
  let db = openLedger(path);
  const config = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"],
    repoDir: "/tmp/p", ...(opts.deploy ? { deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } : {}), ...(opts.handoff ? { mergeHandoff: true } : {}) } } });
  const prNum = (prRef: string) => prRef.split("/").pop()!;
  const idOf = (prRef: string) => cards.find((c) => c.prRef === prRef)!.taskId;
  const { hub, gh, base, newSha } = fakeGitHub({ name: idOf, branch: (pr) => `task/${idOf(pr)}`,
    files: (pr) => opts.files?.(Number(prNum(pr))) ?? `src/${prNum(pr)}.ts` });
  let num = 0;
  const cards: { taskId: string; prRef: string; head: string }[] = [];
  /** An auto code card in `merge` at a fresh head with a passing cross-family review: the planner may plan its merge. */
  const card = (id: string) => {
    const n = ++num, prRef = `https://github.com/${REPO}/pull/${n}`, head = newSha(), at = Date.now();
    createTask(db, { actor: "owner", now: at }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
    setWorkflow(db, { actor: "owner", now: at }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto",
      authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(head, prRef, `task/${id}`, at + n, id);
    // the planner's merge gate wants this round's review dispatch proven: review entered → review intent → its ack → the verdict
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
  const memory = memoryTrainStore(), events = memory.events;
  // "default" reads the very file defaultTrainStore() reads (state dir); "file" a private one handed in through PassOpts.train
  const store = opts.store === "memory" ? memory.store : opts.store === "file" ? fileTrainStore(join(dir, "merge-train")) : fileTrainStore();
  /** PM notices the train tick sent, as "taskId: text". */
  const notices: string[] = [];
  const checks = (p: string) => config.projects[p]?.requiredChecks ?? null;
  /** One launchd job per deploy: it is seen finished (ok) on the pass after its submit, so the slot is released in deployTick. */
  const jobs = new Map<string, "submitted" | "done">();
  const deployJobs: DeployJobs = {
    label: (run) => `${DEPLOY_LABEL_PREFIX}${run.intentId}`,
    submit: async (run) => { jobs.set(run.intentId, "submitted"); hub.calls.push(`deploy:${run.taskId}`); return `${DEPLOY_LABEL_PREFIX}${run.intentId}`; },
    observe: async (run) => {
      const j = jobs.get(run.intentId);
      if (!j) return null;
      return { label: `${DEPLOY_LABEL_PREFIX}${run.intentId}`, liveness: "dead", result: { ok: true, summary: "部署完成" }, deadline: Date.now() + 60_000 };
    },
    remove: async () => true,
  };
  const ledger = (args: string[]) => runLedger(args, { db, actor: "scheduler", projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true,
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
  /** The scheduler's ledger child; `verify` of a deployed card only reports "not yet" (its fact collection runs gh / lsof), and the
   *  memory observer (it needs the service lease) has nothing to do here. */
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => (args[1] === "verify" ? { ok: true, result: "pending" } : args[1] === "memory-auto" ? { ok: true }
    : ledger(args.slice(1)));
  const mstr = mkdtempSync(join(tmpdir(), "mtr1-maint-"));
  const maintenance = { path: join(mstr, "m.lock"), marker: join(mstr, "u.marker"), request: join(mstr, "m.req") };
  const autoDeps = () => ({ manager, now: Date.now, worker: () => ({ manual: "测试里不开会话" }), ensure: async () => { throw new Error("测试里不开会话"); },
    pinReview: async () => ({ manual: "x" }), reviewDirty: async () => null, notifyPm: async () => {}, prState: base.inspect });
  const noop = async () => ({ failed: [] });
  /** One production pass; `budgetMs` small makes every phase yield after its first card (the pace keeps its cursor across passes). */
  let cursor: Record<string, string | undefined> = {};
  /** A daemon restart: a new ledger connection and pass cursor; only the ledger file, the train store and fake GitHub carry over. */
  const restart = () => { closeLedger(path); db = openLedger(path); cursor = {}; };
  /** `arrive` runs right after the in-pass train tick, where a card the train no longer holds would reach this pass's auto tick.
   *  `afterManager` sees every ledger child call of the pass with its result, after it returned and before the pass goes on. */
  const pass = async (o: { budgetMs?: number; arrive?: () => void; afterManager?: (args: string[], result: Record<string, unknown>) => void } = {}) => {
    const before = hub.calls.length;
    const mgr: typeof manager = o.afterManager ? async (...args) => { const r = await manager(...args); o.afterManager!(args, r); return r; } : manager;
    const trainTick = async (d: typeof db, projects: readonly string[], _active: unknown, formFence?: FormFence) => {
      await mergeTrainTick(d, projects, { now: Date.now, formFence, notifyPm: async (t, text) => { notices.push(`${t.id}: ${text}`); } }, { gh, store }, checks);
      o.arrive?.();
    };
    const r = await schedulerPass(db, config, { assertOwner: () => {}, manager: mgr, maintenance, cursor, budgetMs: o.budgetMs ?? 60_000, trainTick,
      external: () => withMergeTrain(base, { gh, store }), deployJobs, autoDeps: autoDeps as never, peerPr: noop,
      autostart: () => ({ resume: async () => [], start: async () => [] }), retire: async () => [], lifecycle: async () => [],
      ...(opts.store === "default" ? {} : { train: { gh, store } }) });
    if (r.failed.length) hub.calls.push(...r.failed.map((f) => `failed:${f.taskId}:${f.error}`));
    return hub.calls.slice(before);
  };
  const intentOf = (id: string) => (db.query(`SELECT id FROM scheduler_intents WHERE taskId=? AND action='merge' ORDER BY eventSeq DESC LIMIT 1`)
    .get(id) as { id: string } | null)?.id ?? null;
  const phase = (id: string) => { const i = intentOf(id); return i ? getMergeRun(db, i)?.phase ?? null : null; };
  const slot = () => (db.query("SELECT taskId FROM scheduler_resources WHERE project='p' AND resource='merge:p'").get() as { taskId: string } | null)?.taskId ?? null;
  const turns = (id: string) => listEvents(db, { project: "p", target: id }).filter((e) => e.data.op === "merge_slot").map((e) => String(e.data.turn));
  /** Take the slot and begin the merge run as the auto tick + mergeTick do, without driving it: the card sits at ready holding the slot. */
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
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(mstr, { recursive: true, force: true }); };
  return { get db() { return db; }, hub, store, events, notices, manager, card, pass, restart, phase, slot, turns, begin, intentOf, close };
}
export type ReclaimWorld = ReturnType<typeof reclaimWorld>;

/**
 * The starvation scenario (MT1 FB1P): T3 (overlapping T1, so never in its car) holds the slot at ready and lends it to the
 * T1+T2 train the pass's own tick formed; the members merge and deploy one by one; from the pass the train stops holding on,
 * one fresh card arrives per pass. A pass the service is stopped in (SchedulerStopped) is followed by a daemon restart.
 * Returns the GitHub / deploy effects in order ("stopped" for a stopped pass), the train's PM notices (ids masked) and
 * whether T3 merged within `passes`.
 */
export async function starvation(w: ReclaimWorld, o: { passes?: number; budgetMs?: number; between?: (i: number) => void } = {}):
  Promise<{ calls: string[]; t3: string | null; turns: string[]; trainDone: boolean; trainLog: string[]; fresh: number }> {
  for (const id of ["T1", "T2", "T3"]) w.card(id);
  await w.begin("T3");
  w.hub.pending = true;
  await w.pass(); // the pass's train tick forms T1+T2 (T3 overlaps T1), then mergeTick has T3 lend the slot to the testing train
  w.hub.pending = false;
  let fresh = 0;
  // one fresh card per pass from the moment the train stops holding (cleanup / done / void / past its limit)
  const arrive = () => { const s = w.store.load("p"); if (s && !trainHolds(s, Date.now())) w.card(`F${++fresh}`); };
  for (let i = 0; i < (o.passes ?? 14) && w.phase("T3") !== "merged"; i++) {
    o.between?.(i);
    try { await w.pass({ budgetMs: o.budgetMs, arrive }); }
    catch (e) {
      if (!(e instanceof SchedulerStopped)) throw e;
      w.hub.calls.push("stopped");
      w.restart();
    }
  }
  const trainLog = w.notices.map((n) => n.replace(/\[合并列车\] 第 \d+ 辆车 [\w-]+：/, "").replace(/\b\d+-[a-z0-9]{4,}\b/g, "<train>"));
  return { calls: w.hub.calls, t3: w.phase("T3"), turns: w.turns("T3"), trainDone: w.store.load("p")?.phase === "done", trainLog, fresh };
}

// The non-test child (default store path): `bun --no-env-file tests/scheduler-merge-reclaim-world.ts` prints the scenario as JSON.
if (import.meta.main) {
  const w = reclaimWorld({ store: "default", deploy: true, files: (n) => (n === 3 ? "src/1.ts" : `src/${n}.ts`) });
  try { console.log(JSON.stringify(await starvation(w))); } finally { w.close(); }
}

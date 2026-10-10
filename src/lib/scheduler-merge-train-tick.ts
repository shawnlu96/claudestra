/**
 * Merge train wiring: the durable state file, the ledger reads (candidates, member outcomes), the per-pass tick
 * (scheduler-pass.ts → mergeTrainPass, before the merge driver, under the pass's lease guard) and the merge-driver hook (scheduler-merge-external.ts → withMergeTrain).
 * State lives in `<stateDir>/merge-train/<project>.json` (atomic tmp+rename): the scheduler is its only writer, and the ledger
 * stays untouched, so no migration and no new ledger command. Test processes get no default context (no real gh, no state dir).
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getTask, getMeta, listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { stateDir } from "./state-dir.js";
import { isTestProcess } from "./test-guard.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { trainGh } from "./scheduler-merge-train-gh.js";
import { trainMode } from "./scheduler-merge-train-switch.js";
import { runBounded } from "./run-bounded.js";
import { foreignRepoOf, projectRepoFor } from "./scheduler-foreign-repo.js";
import { notifyProjectPm } from "./pm-notify.js";
import {
  clearedMember, formTrain, nextSkip, recheckCleared, skipKey, stepTrain, trainGate, trainView, type MemberStatus, type TrainCandidate, type TrainDeps, type TrainEvent,
  type TrainGh, type TrainState, type TrainStore,
} from "./scheduler-merge-train.js";

const EVENTS_KEPT = 200;
interface TrainFile { v: 1; seq: number; state: TrainState | null; view: string; events: TrainEvent[] }
const fileName = (project: string) => `${project.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

/** One JSON file per project; a corrupt file throws (never read as "no train", which would orphan its branches). */
export function fileTrainStore(dir = join(stateDir(), "merge-train")): TrainStore {
  const path = (project: string) => join(dir, fileName(project));
  const read = (project: string): TrainFile => {
    const r = readJsonStateSync(path(project));
    if (r.status === "missing") return { v: 1, seq: 0, state: null, view: "", events: [] };
    if (r.status === "corrupt") throw new Error(`合并列车状态文件损坏：${path(project)}（${r.error}）`);
    return r.data as TrainFile;
  };
  const write = (project: string, f: TrainFile) => { mkdirSync(dir, { recursive: true }); writeJsonAtomicSync(path(project), f); };
  return {
    load: (project) => read(project).state,
    all() {
      let names: string[] = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } // no directory yet = no train ever formed
      // Same three states as read(): a file gone since the listing is no train, a corrupt one throws (the merge override must not
      // read it as "not a member" and fall back to a plain merge that skips the train's recheck of main and sibling heads).
      return names.flatMap((n) => {
        const r = readJsonStateSync(join(dir, n));
        if (r.status === "missing") return [];
        if (r.status === "corrupt") throw new Error(`合并列车状态文件损坏：${join(dir, n)}（${r.error}）`);
        const state = (r.data as TrainFile).state;
        return state ? [state] : [];
      });
    },
    save(state) {
      const f = read(state.project);
      write(state.project, { ...f, seq: Math.max(f.seq, state.seq), state, view: trainView(state) });
    },
    event(project, ev) {
      const f = read(project);
      write(project, { ...f, events: [...f.events, ev].slice(-EVENTS_KEPT) });
      console.log(`🚂 [merge-train] ${project} ${ev.train} ${ev.kind}：${ev.text}`);
    },
    nextSeq: (project) => read(project).seq + 1,
  };
}

const SHA = /^[a-f0-9]{40}$/i;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

/**
 * Auto code cards in `merge` that either wait for the project merge slot or hold it in ready / updating, with a passing review on the
 * current head. A frozen queue, a manual / observe card (PM hold) or an unknown merge intent is never a candidate. Trains never carry
 * ui cards (`ui` null); the manual merge queue's fairness check (manual-merge-queue.ts owedToAuto) passes `{ now }` to also see the ui
 * cards whose screenshot acceptance holds (uiMergeRefusal) — every card the auto tick may legally merge — so no legal auto card
 * starves behind a run of manual requests. A card known to be outside the project's repository (i28-TRAINREPO1) is never a
 * candidate either: the planner's foreign_repo hands it to PM. An unreadable project repository is no verdict (the card stays).
 */
export function mergeCandidates(db: Database, project: string, ui: { now: number } | null): TrainCandidate[] {
  if (getMeta(db, project).queueFrozen.frozen) return [];
  const rows = db.query(`SELECT t.id, w.template FROM tasks t JOIN task_workflows w ON w.taskId = t.id WHERE t.project = ? AND t.stage = 'merge'
    AND t.kind = 'code' AND w.mode = 'auto' AND w.specRev = t.specRev ${ui ? "" : "AND w.template != 'ui'"} ORDER BY t.updatedAt, t.id`).all(project) as
    { id: string; template: string }[];
  const out: TrainCandidate[] = [];
  let repo: string | null | undefined; // read once per call, only when some card got this far
  for (const { id, template } of rows) {
    const task = getTask(db, id);
    if (!task || !SHA.test(task.headSHA ?? "") || !PR_URL.test(task.pr ?? "") || !task.branch) continue;
    if (foreignRepoOf(task, repo === undefined ? (repo = projectRepoFor(project)) : repo)) continue;
    const open = db.query(`SELECT i.id, i.status, m.phase FROM scheduler_intents i LEFT JOIN scheduler_merges m ON m.intentId = i.id
      WHERE i.taskId = ? AND i.action = 'merge' AND i.status IN ('pending','submitted','unknown')`).all(id) as { status: string; phase: string | null }[];
    if (open.some((i) => i.status === "unknown" || (i.phase && !["ready", "updating"].includes(i.phase)))) continue;
    // merged at this head already (a card without auto deploy stays in `merge` for the PM): not waiting for anything
    if (db.query("SELECT 1 FROM scheduler_merges WHERE taskId = ? AND lower(reviewedHead) = lower(?) AND phase = 'merged'").get(id, task.headSHA!)) continue;
    const review = currentReviewFacts(task, listEvents(db, { project, target: id }), (a) => actorMayConfigure(db, a, project));
    if (review.kind !== "facts" || !["pass", "changes"].includes(review.facts.verdict) ||
      review.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) continue;
    if (ui && template === "ui" && uiMergeRefusal(db, task, ui.now)) continue;
    out.push({ taskId: id, prRef: task.pr!, head: task.headSHA! });
  }
  return out;
}

/** The train's candidates: the auto, non-ui cards above. */
export const trainCandidates = (db: Database, project: string): TrainCandidate[] => mergeCandidates(db, project, null);

/** merged = its own merge run recorded the merge at this head; gone = it left the train's reach (head, stage, PM hold). */
export function memberStatusOf(db: Database, taskId: string, head: string): MemberStatus {
  const merged = db.query(`SELECT mergeSha FROM scheduler_merges WHERE taskId = ? AND lower(reviewedHead) = lower(?) AND phase = 'merged'
    AND mergeSha IS NOT NULL ORDER BY updatedAt DESC LIMIT 1`).get(taskId, head) as { mergeSha: string } | null;
  if (merged) return { kind: "merged", sha: merged.mergeSha };
  const task = getTask(db, taskId);
  const mode = (db.query("SELECT mode FROM task_workflows WHERE taskId = ?").get(taskId) as { mode: string } | null)?.mode;
  // head before stage: a card that went back to fix with a new head moved, and a moved verified member voids its train
  if (task && task.headSHA?.toLowerCase() !== head.toLowerCase()) return { kind: "gone", why: `head 变成 ${task.headSHA?.slice(0, 12)}`, moved: true };
  if (!task || task.stage !== "merge") return { kind: "gone", why: `阶段 ${task?.stage ?? "缺卡"}` };
  if (mode !== "auto") return { kind: "gone", why: `流程改为 ${mode ?? "缺流程"}` };
  return { kind: "waiting" };
}

export interface TrainContext { gh: TrainGh; store: TrainStore }
/** The production context; null in a test process so no test ever reaches GitHub or the real state dir through a default. */
const defaultTrainContext = (gh: () => TrainGh = () => trainGh()): TrainContext | null =>
  isTestProcess() ? null : { gh: gh(), store: fileTrainStore() };

/** The context the merge driver's external uses: its gh calls go through the same (guarded) command as every other merge call. */
export const trainContext = (command: Parameters<typeof trainGh>[0]): TrainContext | null => defaultTrainContext(() => trainGh(command));

type Notify = (task: LedgerTask, text: string) => Promise<void>;
/** `formFence` (MQ1, manual-merge-queue-pass.ts): the save of a newly formed train goes through it; a throw = not formed. */
export type FormFence = (project: string, save: () => void) => void;
export interface TrainTickDeps { notifyPm: Notify; now(): number; formFence?: FormFence }

const fenced = (store: TrainStore, project: string, fence: FormFence | undefined): TrainStore =>
  fence ? { ...store, save: (s) => fence(project, () => store.save(s)) } : store;

/** One train step per project per pass; a GitHub hiccup is logged and retried next pass, a stop still ends the pass. */
export async function mergeTrainTick(db: Database, projects: readonly string[], deps: TrainTickDeps,
  ctx: TrainContext | null = defaultTrainContext(), requiredChecks: (project: string) => readonly string[] | null = configChecks): Promise<void> {
  if (!ctx || !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return;
  for (const project of projects) {
    try {
      const required = requiredChecks(project);
      if (!required?.length) continue;
      const train: TrainDeps = { ...ctx, now: deps.now, requiredChecks: required, memberStatus: (id, head) => memberStatusOf(db, id, head),
        notify: async (s, text) => {
          const task = s.members.map((m) => getTask(db, m.taskId)).find(Boolean);
          if (task) await deps.notifyPm(task, text).catch((e) => {
            if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass, it is not a lost notice
            console.error(`⚠️ [merge-train] PM 通知没发出去（状态文件已记）：${(e as Error).message}`);
          });
        } };
      const live = ctx.store.load(project);
      if (live && live.phase !== "done") await stepTrain(live, train);
      else await formTrain(project, trainCandidates(db, project), { ...train, store: fenced(ctx.store, project, deps.formFence) },
        (c) => cachedFiles(ctx.gh, c), nextSkip(live));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      console.error(`⚠️ [merge-train] ${project}：${(e as Error).message}`);
    }
  }
}

/** Checked right before every gh spawn and again when it settles (as scheduler-pass.ts guards the merge driver's runner). */
export const guardedCommand = (active: () => void, command: typeof runBounded = runBounded): typeof runBounded => async (...a) => {
  active();
  try { return await command(...a); } finally { active(); }
};

/**
 * The service pass's entry (scheduler-pass.ts, right before mergeTick, so a drift voids the train before any member merges):
 * every gh call and PM notice is checked against the pass's ownership / lease, and a stop ends the pass with SchedulerStopped.
 */
export async function mergeTrainPass(db: Database, projects: readonly string[], active: () => void,
  ctx: TrainContext | null = trainContext(guardedCommand(active)), formFence?: FormFence): Promise<void> {
  const alive = () => { try { active(); return true; } catch { return false; } };
  await mergeTrainTick(db, projects, { now: Date.now, formFence, notifyPm: async (task, text) => {
    active();
    try { await notifyProjectPm(db, task.project, text, { fromName: "scheduler", stillActive: alive }); } finally { active(); }
  } }, ctx);
}

/** File lists per PR head: without it every pass with no formable batch would re-list every queued PR. */
const filesSeen = new Map<string, string[] | null>();
async function cachedFiles(gh: TrainGh, c: TrainCandidate): Promise<string[] | null> {
  const key = `${c.prRef} ${skipKey(c)}`;
  if (filesSeen.has(key)) return filesSeen.get(key)!;
  const files = await gh.prFiles(c.prRef);
  if (filesSeen.size >= 500) filesSeen.clear();
  filesSeen.set(key, files);
  return files;
}

function configChecks(project: string): readonly string[] | null {
  const config = readSchedulerConfig();
  return config.enabled ? config.projects[project]?.requiredChecks ?? null : null;
}

/** The driver-facing hook: `train` answers trainGate, `merge` uses `--match-head-commit` for a member the train verified. */
export function withMergeTrain(base: MergeExternal, ctx: TrainContext | null = defaultTrainContext()): MergeExternal {
  if (!ctx) return base;
  const io = { ...ctx, now: Date.now, notify: async () => {} };
  // A clearance skips serial preflight; retain its train across mode changes and cleanup until the merge recheck.
  const cleared = new Map<string, TrainState>(), serial = new Set<string>();
  return {
    ...base,
    train: async (run: MergeRun) => {
      const key = `${run.prRef}:${run.reviewedHead}`;
      cleared.delete(key); serial.delete(key);
      if (trainMode(run.project) !== "on") { serial.add(key); return null; }
      const state = ctx.store.load(run.project), gate = await trainGate(state, run, io);
      if (gate === "cleared" && state) cleared.set(key, state);
      return gate;
    },
    async merge(prRef, head) {
      if (serial.delete(`${prRef}:${head}`)) return base.merge(prRef, head);
      let states: TrainState[];
      try { states = ctx.store.all(); }
      catch (e) { // fail closed: no merge sent; the driver journals this reason instead of a plain merge pinned to the PR head only
        throw new Error(`合并列车状态读不出来，本轮不合并（不退回普通合并）：${(e as Error).message}`);
      }
      const key = `${prRef}:${head}`, s = cleared.get(key) ?? clearedMember(states, prRef, head);
      if (!s) return base.merge(prRef, head);
      if (trainMode(s.project) !== "on") throw new Error("列车已关闭，本轮不合并，重新走串行前置检查");
      await recheckCleared(s, io);
      if (trainMode(s.project) !== "on") throw new Error("列车已关闭，本轮不合并，重新走串行前置检查");
      cleared.delete(key);
      return ctx.gh.mergeMatchHead(prRef, head);
    },
  };
}

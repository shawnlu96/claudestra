/**
 * UICAR2 write side: when the scheduler's own update-branch carry (scheduler-merge.ts carryReview) moves a UI card's head, the PM
 * screenshot acceptance on the old head is carried too, only if main's part touches no UI (web/**, src/bridge/**, the card's
 * extra.fileGlobs) by this process's own git, PM's last verdict is approved on `from` with the card's digest, and the card is not
 * ownerVisual. Switch `uiCarry` (recovery-policy.ts): off / observe (record only) / on. Read side: scheduler-ui-carry-read.ts.
 * UIR1 (uiReviewCarry, scheduler-ui-review-carry.ts) is judged in the same call and temp repo, on render-input trees.
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WHOLE_DIFF_ARGS } from "./git-diff-args.js";
import { gitIn, proveCarry, type GitRead } from "./scheduler-ui-carry-proof.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { projectPmUiGate, type PmUiGate } from "./ledger-ui-approve-verdict.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { UI_CARRY_OP, uiCarriedFrom, uiCarryKey } from "./scheduler-ui-carry-read.js";
import { uiReviewCarryMode, uiReviewCarryPlan } from "./scheduler-ui-review-carry.js";
import { DIGEST_RE, ownerVisualOf } from "./scheduler-ui-merge-refusal.js";
import type { CarryEvidence } from "./scheduler-merge.js";

const UI_DIRS = ["web/", "src/bridge/"];

/** One bare temp repo borrowing repoDir's objects carries every proof: the canonical one re-run in full on the receipt
 * (scheduler-ui-carry-proof.ts: graph + net diff, main = the receipt's mainHead), then whatever `fn` reads there. */
function inCarryRepo<T>(repoDir: string, ev: CarryEvidence, fn: (read: GitRead) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ui-carry-"));
  try {
    const read = gitIn(dir), objects = join(gitIn(repoDir)("rev-parse", "--path-format=absolute", "--git-common-dir").toString().trim(), "objects");
    read("init", "-q", "--bare");
    writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    proveCarry(read, ev);
    return fn(read);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** `git diff --name-only <merge-base> <mainParent>`: what main's part of the carry changed. */
function touchedIn(read: GitRead, ev: CarryEvidence): { mainBase: string; files: string[] } {
  const bases = read("merge-base", "--all", ev.oldHead, ev.mainParent).toString().trim().split(/\s+/);
  if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0]!)) throw new Error("merge-base 不唯一");
  const out = read("diff", "--name-only", "-z", ...WHOLE_DIFF_ARGS, "--no-ext-diff", bases[0]!, ev.mainParent).toString();
  return { mainBase: bases[0]!, files: out.split("\0").filter(Boolean) };
}
export const mainTouched = (repoDir: string, ev: CarryEvidence): { mainBase: string; files: string[] } => inCarryRepo(repoDir, ev, (read) => touchedIn(read, ev));

/** Read every time; an unreadable file / unknown key is off. */
export function uiCarryMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, "uiCarry"); return p.source === "error" ? "off" : p.mode; } catch { return "off"; } // unreadable policy: carry nothing
}

/** note: why it was not carried (merge_phase's note); commit(carrySeq): called right after the carry's merge_phase. */
export interface UiCarryPlan { note: string | null; commit: (carrySeq: number) => void }
const NONE: UiCarryPlan = { note: null, commit: () => {} };
export interface UiCarryDeps { policy?: RecoveryPolicyPort; repoDir?: (project: string) => string | undefined }
const configRepoDir = (project: string): string | undefined => readSchedulerConfig().projects[project]?.repoDir;

type Touched = { mainBase: string; files: string[] } | string;
const why = (e: unknown): string => (e as Error).message.split("\n")[0]!.slice(0, 160);

/** UICAR2: main's part touches no UI path. `touched` is the list, or why it could not be read. */
function mainCarryPlan(db: Database, task: LedgerTask, intentId: string, ev: CarryEvidence, now: number, mode: RecoveryMode,
  pm: PmUiGate, ownerVisual: boolean, touched: Touched): UiCarryPlan {
  const c = { intentId, from: ev.oldHead, to: ev.newHead, mainParent: ev.mainParent };
  const refuse = (why: string): UiCarryPlan => ({ note: `${why}，截图验收要 PM 在新 head 上补`.slice(0, 500), commit: () => {} });
  const digest = task.extra.screenshotsDigest, globs = task.extra.fileGlobs ?? [];
  if (ownerVisual) return refuse("本卡要 owner 看截图（ownerVisual）");
  if (pm.state !== "approved" || pm.seq === undefined) return refuse("本轮最后一条 PM 截图结论不是 approved");
  if (pm.head !== c.from || pm.round !== task.round || pm.specRev !== task.specRev || typeof digest !== "string" || !DIGEST_RE.test(digest) ||
    pm.screenshotsDigest !== digest) return refuse("PM 截图验收没绑在原 head / 本轮 / 本规格 / 卡上摘要");
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return refuse("卡上 fileGlobs 不是字符串列表");
  if (typeof touched === "string") return refuse(touched);
  const own = (globs as string[]).map((g) => new Bun.Glob(g));
  const hits = touched.files.filter((f) => UI_DIRS.some((d) => f.toLowerCase().startsWith(d)) || own.some((g) => g.match(f)));
  if (hits.length) return refuse(`main 改了 ${hits.slice(0, 3).join("、")}${hits.length > 3 ? ` 等 ${hits.length} 个文件` : ""}`);
  const data = { intentId: c.intentId, from: c.from, to: c.to, round: task.round, specRev: task.specRev, digest, approvalSeq: pm.seq,
    mainBase: touched.mainBase, mainParent: c.mainParent, touched: [] as string[], changed: touched.files.slice(0, 200) };
  if (mode === "observe") {
    return { note: null, commit: () => void recordObserved(db, { project: task.project, mechanism: "uiCarry", target: task.id, actionKey: `ui-carry:${c.to}`,
      action: `沿用截图验收到 ${c.to.slice(0, 12)}（main 改了 ${touched.files.length} 个文件，都不碰界面）`, data }, now) };
  }
  return { note: null, commit: (carrySeq) => void insertEvent(db, { actor: "scheduler", now, dedupKey: uiCarryKey(c.intentId, carrySeq) }, {
    project: task.project, target: task.id, kind: "scheduler", text: `沿用截图验收到新 head ${c.to.slice(0, 12)}（main 段不碰界面）`,
    data: { op: UI_CARRY_OP, ...data, carrySeq } }, true) };
}

/**
 * Judged on the card before the head move, inside the carry's transaction. Never throws: any doubt is a note, nothing carried.
 * Both switches share one temp repo: UICAR2 (uiCarry, main's touched list) and UIR1 (uiReviewCarry, render-input trees,
 * scheduler-ui-review-carry.ts). While uiReviewCarry is on it supersedes UICAR2 (whose touched list misses root package / lock, shared
 * assets / i18n …): UICAR2 is not judged, and its ui_review_carry is committed first, at carrySeq + 2. Otherwise UICAR2's ui_carry (on)
 * keeps carrySeq + 2 and any observe record follows it. Readers: scheduler-ui-carry-read.ts.
 */
export function uiCarryPlan(db: Database, task: LedgerTask, intentId: string, ev: CarryEvidence, now: number,
  deps: UiCarryDeps = {}): UiCarryPlan {
  if (getWorkflow(db, task.id)?.template !== "ui") return NONE;
  const mode = uiCarryMode(task.project, deps.policy), reviewMode = uiReviewCarryMode(task.project, deps.policy);
  if (mode === "off" && reviewMode === "off") return NONE;
  const events = listEvents(db, { project: task.project, target: task.id });
  const pm = projectPmUiGate(db, task, events), ownerVisual = ownerVisualOf(db, task, events);
  const approval = events.find((e) => e.seq === pm.seq);
  // PM approved an older head: the hops up to this carry's `from` must each be the scheduler's own trusted carry (UIR1 chains)
  const heldFrom = pm.head !== undefined && pm.head !== ev.oldHead && uiCarriedFrom(db, task, events, pm, deps.policy);
  let main: UiCarryPlan = NONE, review: UiCarryPlan = NONE;
  const judge = (read: (() => GitRead) | string, touched: Touched) => {
    if (mode !== "off" && reviewMode !== "on") main = mainCarryPlan(db, task, intentId, ev, now, mode, pm, ownerVisual, touched);
    review = uiReviewCarryPlan(db, { task, intentId, ev, pm, approval, ownerVisual, heldFrom, read, now }, deps.policy);
  };
  let repo: string | undefined, missing = "调度配置里没有本项目的 repoDir，算不了 main 触碰清单";
  try { repo = (deps.repoDir ?? configRepoDir)(task.project); } catch (e) { missing = `调度配置读不了（${why(e)}）`; }
  if (!repo) judge(missing, missing);
  else {
    try {
      inCarryRepo(repo, ev, (read) => {
        let touched: Touched;
        try { touched = touchedIn(read, ev); } catch (e) { touched = `main 触碰清单算不出（${why(e)}）`; }
        judge(() => read, touched);
      });
    } catch (e) { judge(`canonical 沿用在本库证不了（${why(e)}）`, `main 触碰清单算不出（${why(e)}）`); }
  }
  const note = [main.note, review.note].filter(Boolean).join("；").slice(0, 500) || null;
  const [first, then] = reviewMode === "on" ? [review, main] : [main, review];
  return { note, commit: (carrySeq) => { first.commit(carrySeq); then.commit(carrySeq); } };
}

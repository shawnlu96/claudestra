/**
 * UICAR3: the third layer of the scheduler's update-branch screenshot carry, judged in uiCarryPlan's call and temp repo after UICAR2
 * (uiCarry) and UIR1 (uiReviewCarry), and only when neither carried. main's part may touch web/ or src/bridge/ (it nearly always does);
 * what it must not touch is the card's own extra.fileGlobs or any path of the card's net diff (`git diff --name-only mainHead...from`,
 * the canonical proof's net diff). The other conditions are UICAR2's: PM's last verdict approved on `from` with the card's round /
 * specRev / digest, the card not ownerVisual. Switch `uiCarryOwnGlobs` (recovery-policy.ts): on = a `ui_carry` with
 * mechanism=uiCarryOwnGlobs (scheduler-ui-carry-read.ts reads it back while on), observe = one recordObserved, off = nothing.
 * Refusals are silent: the existing manual path stays as it was. The ui_carry itself is written by scheduler-ui-carry.ts (writeCarry),
 * the ledger writer this leaf leaves the event base to. tests/scheduler-ui-carry-own-globs.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import type { PmUiGate } from "./ledger-ui-approve-verdict.js";
import { uiDeclComplete, type UiInputsDeps } from "./project-ui-inputs.js";
import { recordObserved, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { OWN_GLOBS_MECHANISM } from "./scheduler-ui-carry-read.js";
import type { CarryEvidence } from "./scheduler-merge.js";

/** The UI directories UICAR2 refuses on (scheduler-ui-carry.ts mainCarryPlan); UICAR3 only counts them. */
const UI_DIRS = ["web/", "src/bridge/"];
export const isUiPath = (f: string): boolean => UI_DIRS.some((d) => f.toLowerCase().startsWith(d));

/** main's touched files that hit the card: its fileGlobs or a path of its net diff (case-insensitive, a case-folding disk counts). */
export function ownGlobsHits(touched: readonly string[], fileGlobs: readonly string[], netPaths: readonly string[]): string[] {
  const globs = fileGlobs.map((g) => new Bun.Glob(g)), net = new Set(netPaths.map((p) => p.toLowerCase()));
  return touched.filter((f) => net.has(f.toLowerCase()) || globs.some((g) => g.match(f)));
}

/** What uiCarryPlan read in the temp repo: main's touched list and the card's net diff paths, or why either could not be read. */
export type OwnGlobsFacts = { mainBase: string; files: string[]; netPaths: string[] } | string;
export interface OwnGlobsInput { task: LedgerTask; intentId: string; ev: CarryEvidence; pm: PmUiGate; ownerVisual: boolean; facts: OwnGlobsFacts; now: number;
  /** UIINPUT1 (project-ui-inputs.ts): the project's declared UI inputs must be complete and trusted at the new head while projectUiInputs is on. */
  uiInputs?: UiInputsDeps; policy?: RecoveryPolicyPort }
/** carried: on and every condition holds (uiCarryPlan then clears the refusal notes and commits this first, at carrySeq + 2). */
export interface OwnGlobsPlan { carried: boolean; commit: (carrySeq: number) => void }
const NONE: OwnGlobsPlan = { carried: false, commit: () => {} };

export type WriteCarry = (carrySeq: number, text: string, data: Record<string, unknown>) => void;
/** Never throws; any failed condition is NONE (no note, no event). */
export function ownGlobsCarryPlan(db: Database, x: OwnGlobsInput, mode: RecoveryMode, writeCarry: WriteCarry): OwnGlobsPlan {
  if (mode === "off") return NONE;
  const { task, ev, pm, facts } = x, digest = task.extra.screenshotsDigest, globs = task.extra.fileGlobs ?? [];
  if (x.ownerVisual || pm.state !== "approved" || pm.seq === undefined || pm.head !== ev.oldHead || pm.round !== task.round ||
    pm.specRev !== task.specRev || typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest) || pm.screenshotsDigest !== digest) return NONE;
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string") || typeof facts === "string") return NONE;
  if (ownGlobsHits(facts.files, globs as string[], facts.netPaths).length) return NONE;
  const decl = uiDeclComplete({ db, project: task.project, task: task.id, path: "ownGlobs", now: x.now, read: null, targetHead: ev.newHead,
    fileGlobs: globs as string[], deps: x.uiInputs, policy: x.policy });
  if (decl.outcome.status !== "same") return NONE; // on only: undeclared / inferred / stale / unknown carries nothing (the review layer says why)
  const plan = carryPlan(db, x, mode, writeCarry, decl.mode === "on" ? decl.outcome.summary : null);
  return { ...plan, commit: (carrySeq) => { plan.commit(carrySeq); decl.observe(); } }; // observe's note after the carry's own record
}

function carryPlan(db: Database, x: OwnGlobsInput, mode: RecoveryMode, writeCarry: WriteCarry, uiInputs: unknown): OwnGlobsPlan {
  const { task, ev, pm } = x, digest = task.extra.screenshotsDigest, facts = x.facts as Exclude<OwnGlobsFacts, string>;
  const ui = facts.files.filter(isUiPath);
  const data = { intentId: x.intentId, from: ev.oldHead, to: ev.newHead, round: task.round, specRev: task.specRev, digest, approvalSeq: pm.seq,
    mainBase: facts.mainBase, mainParent: ev.mainParent, mechanism: OWN_GLOBS_MECHANISM, touched: ui.slice(0, 200), uiTouched: ui.length,
    ownFiles: facts.netPaths.length, changed: facts.files.slice(0, 200), ...(uiInputs ? { uiInputs } : {}) };
  if (mode === "observe") {
    return { carried: false, commit: () => void recordObserved(db, { project: task.project, mechanism: OWN_GLOBS_MECHANISM, target: task.id,
      actionKey: `ui-carry-own-globs:${ev.newHead}`, action: `沿用截图验收到 ${ev.newHead.slice(0, 12)}（main 段改了 ${ui.length} 个界面文件，` +
        `都不碰本卡 ${facts.netPaths.length} 个文件与 fileGlobs）`, data }, x.now) };
  }
  return { carried: true, commit: (carrySeq) => writeCarry(carrySeq,
    `沿用截图验收到新 head ${ev.newHead.slice(0, 12)}（main 段改了 ${ui.length} 个界面文件，不碰本卡文件）`, data) };
}

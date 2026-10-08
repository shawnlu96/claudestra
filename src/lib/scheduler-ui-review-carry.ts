/**
 * UIR1: PM's screenshot acceptance survives the scheduler's own update-branch carry (review_carry) when the render inputs of the
 * approved head and the new head are byte-identical trees — not when main's diff, a file count or the screenshot digest merely look
 * unchanged. Inputs (RENDER_DIRS / RENDER_FILES / the card's fileGlobs) are read with `git ls-tree -r` in the same temp repo where the
 * canonical carry proof is re-run; a symlink or submodule among them, a missing web/ or any changed entry carries nothing.
 * The trusted record is `ui_review_carry`, written only by advanceMergeRun's carry transaction (scheduler-merge.ts carryReview →
 * scheduler-ui-carry.ts uiCarryPlan) right after the carry's merge_phase; ownerVisual cards are never carried (owner asks stay bound
 * to their own head and expiry). Switch `uiReviewCarry` (recovery-policy.ts): on = write + gate, observe = record why only, off = as
 * before. Reads: scheduler-ui-carry-read.ts. tests/scheduler-ui-review-carry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import type { PmUiGate } from "./ledger-ui-approve-verdict.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { GitRead } from "./scheduler-ui-carry-proof.js";
import type { CarryEvidence, MergeRun } from "./scheduler-merge.js";

const UI_REVIEW_CARRY_OP = "ui_review_carry";
const uiReviewCarryKey = (intentId: string, carrySeq: number): string => `scheduler:${intentId}:ui-review-carry:${carrySeq}`;
/** Whole directories (any depth) and root files a screenshot is rendered from: the web app, the bridge serving it, shared assets,
 * and the build's dependency / toolchain config. Compared case-insensitively, so a case-only rename on a case-folding disk still counts. */
const RENDER_DIRS = ["web", "src/bridge", "assets", "public", "static", "styles", "i18n", "locales"] as const;
const RENDER_FILES = new RegExp(`^(${["package\\.json", "package-lock\\.json", "npm-shrinkwrap\\.json", "bun\\.lockb?", "yarn\\.lock", "pnpm-lock\\.yaml",
  "pnpm-workspace\\.yaml", "bunfig\\.toml", "\\.npmrc", "\\.nvmrc", "\\.node-version", "\\.bun-version", "\\.gitattributes", "\\.gitmodules",
  "tsconfig[\\w.-]*\\.json", "[\\w.-]+\\.config\\.(js|cjs|mjs|ts|cts|mts|json)"].join("|")})$`, "i");

/** Runtime call probe: the default wiring (advanceMergeRun's carry, uiMergeRefusal's read, the unsent end) bumps these. */
export const uiReviewCarryCalls = { plan: 0, read: 0, unsent: 0 };

/** Read every time through the one policy reader; an unreadable file / unknown key / throwing port is off. */
export function uiReviewCarryMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, "uiReviewCarry"); return p.source === "error" ? "off" : p.mode; } catch { return "off"; } // unreadable policy: carry nothing
}

interface Entry { mode: string; type: string; oid: string; path: string }
const isInput = (path: string, globs: readonly Bun.Glob[]): boolean => {
  const p = path.toLowerCase();
  return RENDER_DIRS.some((d) => p === d || p.startsWith(`${d}/`)) || (!p.includes("/") && RENDER_FILES.test(p)) || globs.some((g) => g.match(path));
};

/** The render inputs of one commit as `mode type oid\tpath` lines, their sha256, and how many. Throws on anything ambiguous. */
export function renderInputs(read: GitRead, commit: string, fileGlobs: readonly string[]): { digest: string; count: number } {
  const globs = fileGlobs.map((g) => new Bun.Glob(g));
  const entries: Entry[] = read("ls-tree", "-r", "-z", "--full-tree", commit).toString().split("\0").filter(Boolean).map((line) => {
    const m = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/s.exec(line);
    if (!m) throw new Error("ls-tree 输出读不懂");
    return { mode: m[1]!, type: m[2]!, oid: m[3]!, path: m[4]! };
  });
  const picked = entries.filter((e) => isInput(e.path, globs));
  const odd = picked.find((e) => e.mode === "120000" || e.type !== "blob");
  if (odd) throw new Error(`渲染输入 ${odd.path.slice(0, 120)} 是符号链接或子模块，内容不可核`);
  if (!picked.some((e) => e.path.toLowerCase().startsWith("web/"))) throw new Error(`${commit.slice(0, 12)} 缺 web/，渲染输入不全`);
  const text = picked.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`).sort().join("\n");
  return { digest: createHash("sha256").update(text).digest("hex"), count: picked.length };
}

/** What the carry transaction hands over: the pre-move card, PM's verdict and the temp repo the canonical proof just passed in. */
export interface ReviewCarryInput { task: LedgerTask; intentId: string; ev: CarryEvidence; pm: PmUiGate; approval: LedgerEvent | undefined;
  ownerVisual: boolean; heldFrom: boolean; read: (() => GitRead) | string; now: number }
export interface ReviewCarryPlan { note: string | null; commit: (carrySeq: number) => void }
const NONE: ReviewCarryPlan = { note: null, commit: () => {} };

/** Judged inside the carry's transaction before the head moves. Never throws: any doubt is a note, nothing carried. */
export function uiReviewCarryPlan(db: Database, x: ReviewCarryInput, policy?: RecoveryPolicyPort): ReviewCarryPlan {
  uiReviewCarryCalls.plan++;
  const mode = uiReviewCarryMode(x.task.project, policy);
  if (mode === "off") return NONE;
  const { task, ev, pm } = x, digest = task.extra.screenshotsDigest, globs = task.extra.fileGlobs ?? [];
  const base = { intentId: x.intentId, from: ev.oldHead, to: ev.newHead, round: task.round, specRev: task.specRev };
  const refuse = (why: string): ReviewCarryPlan => {
    const note = `截图验收不继承：${why}，要 PM 在新 head ${ev.newHead.slice(0, 12)} 上重新验收`.slice(0, 500);
    if (mode === "on") return { note, commit: () => {} };
    return { note: null, commit: () => void recordObserved(db, { project: task.project, mechanism: "uiReviewCarry", target: task.id,
      actionKey: `ui-review-carry:${ev.newHead}`, action: note, data: { ...base, carried: false } }, x.now) };
  };
  if (x.ownerVisual) return refuse("本卡要 owner 看截图（ownerVisual），owner 授权只认它自己绑的 head 与有效期");
  if (pm.state !== "approved" || pm.seq === undefined || !pm.head || x.approval?.seq !== pm.seq) return refuse("本卡最后一条 PM 截图结论不是 approved");
  if (pm.round !== task.round || pm.specRev !== task.specRev || typeof digest !== "string" || pm.screenshotsDigest !== digest) {
    return refuse("PM 截图验收没绑在本轮 / 本规格 / 卡上摘要");
  }
  if (pm.head !== ev.oldHead && !x.heldFrom) return refuse("PM 截图验收的 head 到原 head 之间不是调度器的可信沿用链");
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return refuse("卡上 fileGlobs 不是字符串列表");
  let inputs: { approved: string; from: string; to: string; count: number };
  try {
    if (typeof x.read === "string") throw new Error(x.read);
    const read = x.read(), at = (h: string) => renderInputs(read, h, globs as string[]);
    const approved = at(pm.head), from = pm.head === ev.oldHead ? approved : at(ev.oldHead), to = at(ev.newHead);
    inputs = { approved: approved.digest, from: from.digest, to: to.digest, count: to.count };
  } catch (e) { return refuse(`渲染输入核不了（${(e as Error).message.split("\n")[0]!.slice(0, 160)}）`); }
  if (inputs.approved !== inputs.to || inputs.from !== inputs.to) return refuse("新 head 的渲染输入（web/、资源、依赖与构建配置）和批准时不同");
  const data = { ...base, approvedHead: pm.head, approvalSeq: pm.seq, approvalActor: x.approval!.actor, approvalOp: x.approval!.data.op, ask: null,
    digest, renderInputs: inputs.to, renderCount: inputs.count, mainParent: ev.mainParent, mainHead: ev.mainHead, diffHash: ev.diffHash };
  if (mode === "observe") {
    return { note: null, commit: () => void recordObserved(db, { project: task.project, mechanism: "uiReviewCarry", target: task.id,
      actionKey: `ui-review-carry:${ev.newHead}`, action: `继承截图验收到 ${ev.newHead.slice(0, 12)}（渲染输入 ${inputs.count} 项与批准时一致）`,
      data: { ...data, carried: true } }, x.now) };
  }
  return { note: null, commit: (carrySeq) => void insertEvent(db, { actor: "scheduler", now: x.now, dedupKey: uiReviewCarryKey(x.intentId, carrySeq) }, {
    project: task.project, target: task.id, kind: "scheduler", text: `继承截图验收到新 head ${ev.newHead.slice(0, 12)}（渲染输入与批准时一致）`,
    data: { op: UI_REVIEW_CARRY_OP, ...data, carrySeq } }, true) };
}

const own = (e: LedgerEvent | undefined, op: string): e is LedgerEvent => e?.kind === "scheduler" && e.actor === "scheduler" && e.data.op === op;

/**
 * The ui_review_carry the scheduler wrote for carry `c`: right after its merge_phase (behind a UICAR2 ui_carry when both wrote),
 * under its own key, bound to the same intent / heads / main evidence / round / specRev / digest and to PM's still-current approval.
 * Only while uiReviewCarry is on: observe and off never let it open the gate.
 */
export function reviewCarryPaired(c: LedgerEvent, bySeq: Map<number, LedgerEvent>, task: LedgerTask, pm: PmUiGate, policy?: RecoveryPolicyPort): boolean {
  uiReviewCarryCalls.read++;
  const phase = bySeq.get(c.seq + 1), next = bySeq.get(c.seq + 2);
  const u = own(next, UI_REVIEW_CARRY_OP) ? next : own(next, "ui_carry") ? bySeq.get(c.seq + 3) : undefined, d = u?.data;
  return own(u, UI_REVIEW_CARRY_OP) && own(phase, "merge_phase") && phase.data.carrySeq === c.seq && phase.data.intentId === c.data.intentId &&
    u.dedupKey === uiReviewCarryKey(String(c.data.intentId), c.seq) && d!.carrySeq === c.seq && d!.intentId === c.data.intentId &&
    d!.from === c.data.from && d!.to === c.data.to && d!.mainParent === c.data.mainParent && d!.mainHead === c.data.mainHead &&
    d!.diffHash === c.data.diffHash && d!.round === c.data.round && d!.round === task.round && d!.specRev === c.data.specRev &&
    d!.specRev === task.specRev && d!.digest === task.extra.screenshotsDigest && d!.approvalSeq === pm.seq && d!.approvedHead === pm.head && bySeq.get(pm.seq!)?.actor === d!.approvalActor &&
    pm.state === "approved" && typeof d!.renderInputs === "string" && /^[a-f0-9]{64}$/.test(d!.renderInputs) &&
    uiReviewCarryMode(task.project, policy) === "on";
}

/** No merge has gone out from these phases (scheduler-merge-conflict.ts BOUNCE_PHASES). A `merging` row is never ended here: the claim
 * row reads the same before and after the send, so nothing durable proves the call did not go out (it keeps unknown + freeze). */
const UNSENT_PHASES: readonly string[] = ["ready", "updating", "await_ci"];
const MANUAL_MERGE_NODE = "manual_merge"; // manual-merge-queue-facts.ts (imports the UI gate, so not imported here)
/** The merge gates, handed in by advanceMergeRun (they live above this leaf): the cross-family review proof and the UI gate. */
export interface UnsentGates {
  proof: (db: Database, task: LedgerTask, workflow: TaskWorkflow) => unknown;
  ui: (db: Database, task: LedgerTask, now: number) => string | null;
}

/** Null when everything but the screenshot gate still holds for this run, re-read here on its own (never from mergeRunDrift's text). */
function onlyUiBlocks(db: Database, ctx: WriteCtx, row: MergeRun, gates: UnsentGates, now: number): { ui: string } | null {
  const task = getTask(db, row.taskId), wf = getWorkflow(db, row.taskId), intent = getIntent(db, row.intentId);
  if (ctx.actor !== "scheduler" || !UNSENT_PHASES.includes(row.phase) || row.mergeSha || !task || !wf || !intent) return null;
  if (wf.template !== "ui" || wf.mode !== "auto" || wf.specRev !== task.specRev || intent.action !== "merge" || intent.status !== "submitted" ||
    intent.node === MANUAL_MERGE_NODE || intent.taskId !== task.id || intent.specRev !== task.specRev) return null;
  if (task.project !== row.project || task.stage !== "merge" || task.headSHA !== row.reviewedHead || task.pr !== row.prRef ||
    task.branch !== row.expectedBranch || getMeta(db, row.project).queueFrozen.frozen) return null;
  if (!db.query("SELECT 1 FROM scheduler_resources WHERE project=? AND resource=? AND intentId=?").get(row.project, `merge:${row.project}`, row.intentId)) return null;
  try { gates.proof(db, task, wf); } catch { return null; } // review missing / same family / P0-P1 / pool: not ours to hide, stays unknown
  const ui = gates.ui(db, task, now);
  return ui ? { ui } : null;
}

/**
 * advanceMergeRun's `→ unknown`, beside the manual cancel: an auto UI card whose run sent no merge (ready / updating / await_ci) and
 * whose only blocker is the screenshot gate (onlyUiBlocks). Under on the run ends resolved / cancelled with its slot freed and the
 * queue untouched; the card keeps its head and still lacks PM's approval, so the planner raises merge_ui_unapproved for PM. Observe
 * records the prediction only; off, any other drift, a `merging` row or a lost CAS (checked before this call) keep unknown + freeze.
 * True = ended here.
 */
export function uiUnsentEnd(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string | undefined, gates: UnsentGates, policy?: RecoveryPolicyPort): boolean {
  uiReviewCarryCalls.unsent++;
  const mode = uiReviewCarryMode(row.project, policy), now = ctx.now ?? Date.now();
  if (mode === "off") return false;
  const only = onlyUiBlocks(db, ctx, row, gates, now);
  if (!only) return false;
  const why = `未发出 merge，唯一阻塞是截图验收（${only.ui.slice(0, 200)}）；等 PM 在 head ${row.reviewedHead.slice(0, 12)} 上重新验收，不冻结队列`;
  if (mode === "observe") {
    recordObserved(db, { project: row.project, mechanism: "uiReviewCarry", target: row.taskId, actionKey: `ui-unsent:${row.intentId}:${row.rev}`,
      action: `结清合并运行（${why}）`, data: { intentId: row.intentId, phase: row.phase } }, now);
    return false;
  }
  db.prepare("UPDATE scheduler_merges SET phase='resolved', rev=rev+1, reason=?, unknownSince=NULL, updatedAt=? WHERE intentId=?")
    .run(`cancelled: ${why}`.slice(0, 600), now, row.intentId);
  settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to: "cancelled", receipt: `merge cancelled（${why}）`.slice(0, 600) });
  db.prepare("DELETE FROM scheduler_resources WHERE intentId=?").run(row.intentId);
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:cancelled` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：${why}`.slice(0, 600),
    data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: "resolved", outcome: "cancelled", receipt: receipt ?? null, uiUnsent: true },
  }, true);
  return true;
}

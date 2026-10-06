/**
 * dispatch-recovery-MODELW: the one production caller of MODEL's recordModelOutcome — the auto tick's "turn failed" branch.
 * The record goes through createRecoveryRuntimePorts with REFA's ledger approval port and CFG's recoveryPolicy, loaded at
 * run time from CFG's frozen location (no file = no port, MODEL observes; a broken module = a throwing port, MODEL turns off).
 * The caller escalates as before unless a refusal continuation ran; this step answers a suffix for its reason. "" = today's text
 * exactly: observe / off / none / manual plans and every wiring error (logged as one diagnostic line). Mode on with a redispatch
 * plan appends "MODEL 计划：redispatch …，执行路径待 MODELX" (no formal path re-sends an order yet). A retry_same / exempt_review plan
 * follows a provider policy refusal of a review: MODELX executes it as exempt_review (owner 10-06 14:45, A — no same-model retry)
 * through beginRefusalEpoch (one transaction, in this service like MODEL's own record) and the card is not escalated; a refused
 * execution escalates with why. The owner gets one inform note per card and refusal kind, and one action note when the exempt
 * review is refused too (manual). failedReason shortens a long host message so the plan survives the cap. The record is deduped
 * per intent by MODEL's key; the epoch by its plan seq; the escalate by its own; the inform by card + kind.
 * tests/scheduler-model-wiring*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { createRecoveryRuntimePorts } from "./recovery-runtime-ports.js";
import type { LocalFamilies } from "./scheduler-local-families-config.js";
import { reviewAfterBounce } from "./scheduler-merge-conflict.js";
import type { MaterialDigest } from "./scheduler-review-swap.js";
import { workOrderFor } from "./scheduler-work-order.js";
import { beginRefusalEpoch } from "./scheduler-sessions.js";
import type { OutcomeInput, OutcomeSignal, RecoveryPolicyPort } from "./scheduler-model-outcome.js";
import type { SessionRef } from "./worker-session.js";
import { cfgReaderPath } from "./recovery-materials-wiring.js" with { type: "macro" };

/** The slice of the auto tick's Card this step reads; structural so auto-tick keeps Card private. */
export interface ModelWiringCard {
  readonly db: Database;
  readonly task: LedgerTask;
  readonly opts: { pool?: { remote: LocalFamilies } };
  readonly deps: { now(): number };
}

type Failure = NonNullable<OutcomeSignal["failure"]>;
type Placement = OutcomeInput["authorized"][number];

const CFG_READER: string = cfgReaderPath();
let readerAt: string | URL = CFG_READER;
/** Tests point the CFG reader at a stand-in module; undefined restores CFG's frozen location. */
export function setModelOutcomeReader(at?: string | URL): void { readerAt = at ?? CFG_READER; }

const diag = (line: string): void => console.error(`[model-outcome] ${line}`.slice(0, 400));

/** CFG's recoveryPolicy, or undefined when not installed (MODEL's own observe default). A broken module throws on every read. */
async function loadPolicy(): Promise<RecoveryPolicyPort | undefined> {
  const at = typeof readerAt === "string" ? pathToFileURL(readerAt) : readerAt;
  if (at.protocol !== "file:" || !existsSync(fileURLToPath(at))) return undefined;
  let fn: unknown;
  try { fn = ((await import(at.href)) as Record<string, unknown>).recoveryPolicy; } catch (e) { fn = e; }
  if (typeof fn === "function") return fn as RecoveryPolicyPort;
  const why = fn instanceof Error ? `CFG recoveryPolicy 加载失败：${fn.message}` : "CFG 模块没有导出函数 recoveryPolicy";
  return () => { throw new Error(why); };
}

/** The machine as MODEL's placements name it: this machine's own runtimes are "local", a peer session is its agent. */
const machineOf = (ref: SessionRef): string => ref.transport === "peer" ? ref.agent : "local";

/** This machine's allowed families now (the auto tick's pool config; none configured = both, as MODEL has always read it). */
const localFamiliesOf = (card: Pick<ModelWiringCard, "opts">): AuthorFamily[] => card.opts.pool?.remote.localFamilies ?? ["claude", "codex"];

/** Already authorized placements: the bound one first (MODEL's first-refusal plan names it), then this machine's allowed families. */
function authorizedFor(card: ModelWiringCard, failed: Placement): Placement[] {
  const families = localFamiliesOf(card);
  const out = [failed];
  for (const family of families) if (!out.some((p) => p.family === family && p.machine === "local")) out.push({ family, machine: "local" });
  return out;
}

/**
 * Record the failed turn with MODEL; answers the suffix for the caller's escalate reason ("" = unchanged), or { epoch } when the
 * refusal continuation ran and the card goes on without escalating. Under on, a redispatch plan is named as pending; a safety
 * refusal informs the owner once per card and kind.
 */
export async function modelOutcomeStep(card: ModelWiringCard, sent: SchedulerIntent, ref: SessionRef, failure: Failure): Promise<string | { epoch: string }> {
  let r: ReturnType<ReturnType<typeof createRecoveryRuntimePorts>["recordModelOutcome"]>;
  try {
    const policy = await loadPolicy();
    const ports = createRecoveryRuntimePorts({ ...(policy ? { policy } : {}), refusalApproval: createRefusalApprovalPort(card.db),
      onDiag: (d) => diag(`${card.task.id} ${d.mechanism}：${d.reason}`) });
    const failed = { family: ref.family, machine: machineOf(ref) };
    r = ports.recordModelOutcome(card.db, { actor: "scheduler", now: card.deps.now() }, { intentId: sent.id, signal: { failure },
      failed: { ...failed, agent: ref.agent }, authorized: authorizedFor(card, failed), ended: true,
      ...(ref.role === "reviewer" ? { review: { sessionId: ref.sessionId, materialDigest: reviewMaterialDigest(card.db)(card.task, sent) } } : {}) });
  } catch (e) {
    diag(`${card.task.id} 意图 ${sent.id} 记模型结果失败，照旧退人工：${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
  if (r.kind === "off") { if (r.diag) diag(`${card.task.id} 模型结果按 off：${r.diag}`); return ""; }
  if (r.kind !== "recorded" || r.mode !== "on") return "";
  const p = r.plan;
  if (p.kind === "retry_same" || p.kind === "exempt_review") {
    const done = runEpoch(card, r.event.seq, authorizedFor(card, { family: ref.family, machine: machineOf(ref) }));
    informOwnerOnce(card, r.event, "error" in done ? null : done.event);
    if (!("error" in done)) return { epoch: `${done.event.text}（台账 #${done.event.seq}${done.duplicate ? "，已执行过" : ""}）` };
    return `；MODEL 计划：${p.kind}（批准 ${p.approvalId}，台账 #${r.event.seq}）未执行：${done.error}`;
  }
  if (r.cls === "safety") {
    informOwnerOnce(card, r.event, null);
    ownerActionOnce(card, r.event);
  }
  if (p.kind === "manual") return "";
  return `；MODEL 计划：${p.kind}（→ ${p.to.machine}（${p.to.family}），无现成正式路径），执行路径待 MODELX（台账 #${r.event.seq}，未执行）：${p.reason}`;
}

const PLACEHOLDER = { agent: "<reviewer>", sessionId: "<session>", family: "<family>" as AuthorFamily, checkout: "<checkout>", order: "<order>" };
const pathsIn = (lines: readonly string[]): string[] => [...new Set(lines.flatMap((l) => l.match(/\/[^\s，。；：（）()]+/g) ?? []))].sort();

/**
 * MODELX: the review materials of a ticket, as the order would carry them now — the full review order (inputs, outputs,
 * acceptance, write-back, findings) with only the ticket's own identity and address (order id, reviewer, session, family,
 * checkout) replaced by placeholders, plus the bytes of every file its inputs name (fix_strategy's prior-report material and
 * the like). Two tickets with equal digests are sent the same words over the same material bytes. plan: the dispatching
 * plan's workOrder (a merge bounce); without it the planner's own rule rebuilds it from the ledger.
 */
export const reviewMaterialDigest = (db: Database): MaterialDigest => (task, sent, plan) => {
  const bounce = plan === undefined ? reviewAfterBounce(listEvents(db, { project: task.project, target: task.id })) : null;
  const facts = plan === undefined ? (bounce ? { workOrder: { reportPath: "", findings: [], fallbackWarning: null, bounce } } : null) : plan;
  const order = workOrderFor(task, { ...sent, id: PLACEHOLDER.order }, facts as Parameters<typeof workOrderFor>[2],
    { taskId: task.id, role: "reviewer", agent: PLACEHOLDER.agent, sessionId: PLACEHOLDER.sessionId, family: PLACEHOLDER.family, transport: "tmux" },
    PLACEHOLDER.checkout, db);
  const hash = createHash("sha256").update(JSON.stringify([task.project, task.id, order]));
  for (const file of pathsIn(order?.inputs ?? [])) {
    let bytes: Buffer | null = null;
    try { if (statSync(file).isFile()) bytes = readFileSync(file); } catch { /* not a file: the line itself is the material */ }
    if (bytes) hash.update(`\0${file}\0${bytes.length}\0`).update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
};

/** The refusal kind the owner hears about: Codex's cyber-policy cut vs any other usage-policy refusal. */
export const refusalKind = (evidence: string): "cyber_policy" | "usage_policy" => isCyberPolicy(evidence) ? "cyber_policy" : "usage_policy";
export const informKey = (taskId: string, kind: string): string => `model-refusal-inform:${taskId}:${kind}`;

/** MODEL's recorded plan event → the refusal epoch, or why not (every guard re-read in the writer's transaction). */
function runEpoch(card: ModelWiringCard, planSeq: number, authorized: Placement[]): { event: LedgerEvent; duplicate: boolean } | { error: string } {
  try {
    return beginRefusalEpoch(card.db, { actor: "scheduler", now: card.deps.now() }, card.task.id, planSeq, authorized, reviewMaterialDigest(card.db));
  } catch (e) {
    if (!(e instanceof LedgerError)) diag(`${card.task.id} 拒审接续执行失败，退人工：${e instanceof Error ? e.message : String(e)}`);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** One owner note per key (no push, no buttons), deduped across ticks and restarts; a failed write is one diagnostic line. */
function ownerNoteOnce(card: ModelWiringCard, key: string, text: string, data: Record<string, unknown>): void {
  try {
    if (getEventByDedup(card.db, key)) return;
    appendEvent(card.db, { actor: "scheduler", now: card.deps.now(), dedupKey: key }, { project: card.task.project, target: card.task.id, kind: "note",
      text, data: { audience: "owner", ...data } });
  } catch (e) {
    diag(`${card.task.id} 拒审告知 owner 没记上：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Under on, a safety refusal tells the owner once per card and refusal kind (inform): what ran, or that the card is paused. */
function informOwnerOnce(card: ModelWiringCard, record: LedgerEvent, epoch: LedgerEvent | null): void {
  const kind = refusalKind(String(record.data.evidence ?? "")), id = card.task.id;
  const what = epoch ? `已按 owner 规矩直接换家族审一次：${epoch.text}；提示词和材料不改，新审查员独立判断，它也拒就停人工`
    : "本卡暂停，交 PM / owner 处置";
  ownerNoteOnce(card, informKey(id, kind), `[调度引擎] ${id} 审查被模型提供方策略拒绝（${kind}）：${what}；原文已留证（台账 #${record.seq}）；` +
    "要按卡挂起用 extra.refusalHold", { op: "refusal_owner_inform", kind: "inform", refusal: kind, recordSeq: record.seq, ...(epoch ? { epochSeq: epoch.seq } : {}) });
}

/** The exempt review was refused too: manual, and the owner gets one note to act on for the card (not per refusal). */
function ownerActionOnce(card: ModelWiringCard, record: LedgerEvent): void {
  const epoch = listEvents(card.db, { project: card.task.project, target: card.task.id })
    .findLast((e) => e.kind === "scheduler" && e.data.op === "reviewer_swap" && !!e.data.refusal && e.seq < record.seq &&
      e.data.head === record.data.head && e.data.specRev === record.data.specRev && e.data.round === record.data.round);
  if (!epoch || (record.data.plan as { kind?: string } | undefined)?.kind !== "manual") return;
  ownerNoteOnce(card, `model-refusal-manual:${card.task.id}`, `[调度引擎] ${card.task.id} 豁免审查也被拒（台账 #${record.seq}，豁免 #${epoch.seq}）：` +
    "已停人工，不再换提供方，需要 owner 处理", { op: "refusal_owner_manual", kind: "action", recordSeq: record.seq, epochSeq: epoch.seq });
}

/** The auto tick's oneLine cap on an escalate reason (ledger event, PM notice, detail). */
const REASON_MAX = 560, MESSAGE_FLOOR = 120;
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The failed turn's escalate reason. No plan = today's text exactly. With a plan, the host message is shortened first so the
 * plan's kind, approval and "pending MODELX" (the suffix's head) survive the cap; MODEL's reason, last, is what gets cut.
 */
export function failedReason(head: string, message: string, plan: string): string {
  if (!plan) return `${head}：${message}`;
  const msg = flat(message), room = REASON_MAX - head.length - 1 - flat(plan).length;
  return `${head}：${msg.length <= room ? msg : `${msg.slice(0, Math.max(room, MESSAGE_FLOOR) - 1)}…`}${plan}`;
}

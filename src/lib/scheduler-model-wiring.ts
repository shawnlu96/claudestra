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
 * Materials (r4): each formal review order is frozen as it goes out (freezeReviewMaterials); MODEL records that snapshot's digest
 * and every later step checks against it (reviewMaterialCheck) — no snapshot, a changed or unreadable file → manual.
 * tests/scheduler-model-wiring*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import { specPathFor } from "./task-spec.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { createRecoveryRuntimePorts } from "./recovery-runtime-ports.js";
import type { LocalFamilies } from "./scheduler-local-families-config.js";
import { reviewAfterBounce } from "./scheduler-merge-conflict.js";
import type { MaterialCheck, OrderPlan } from "./scheduler-review-swap.js";
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

/**
 * MODELX r4 (监工 10-06 19:1x): every formal review dispatch freezes its materials before the order goes out — the normalized
 * order (the full review order with only the ticket's identity and address replaced: order id, reviewer, session, family, checkout)
 * and a structured list of the real files behind it, each { path, sha256 }: the spec body (task.spec as specPathFor resolves it),
 * the prior round's review report, and fix_strategy's material. Paths come from structured fields, never from the order's text.
 * A refusal continuation compares only against this snapshot, item by item, re-hashing each file: any difference, an unreadable or
 * missing file, or no snapshot at all (an order sent before this existed) refuses the continuation — never "unreadable = unchecked".
 */
export const snapshotKey = (intentId: string): string => `review-materials:${intentId}`;
const SNAPSHOT_OP = "review_material_snapshot";
type Role = "spec" | "prior_report" | "fix_strategy";
interface Item { role: Role; path: string | null; sha256?: string; error?: string }
const ROLE: Record<Role, string> = { spec: "规格正文", prior_report: "上一轮审查报告", fix_strategy: "fix_strategy 材料" };
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The normalized order text: as it goes out, with only the ticket's own identity and address replaced by placeholders. */
function normalizedOrder(db: Database, task: LedgerTask, sent: SchedulerIntent, plan?: OrderPlan): string {
  const bounce = plan === undefined ? reviewAfterBounce(listEvents(db, { project: task.project, target: task.id })) : null;
  const facts = plan === undefined ? (bounce ? { workOrder: { reportPath: "", findings: [], fallbackWarning: null, bounce } } : null) : plan;
  const order = workOrderFor(task, { ...sent, id: PLACEHOLDER.order }, facts as Parameters<typeof workOrderFor>[2],
    { taskId: task.id, role: "reviewer", agent: PLACEHOLDER.agent, sessionId: PLACEHOLDER.sessionId, family: PLACEHOLDER.family, transport: "tmux" },
    PLACEHOLDER.checkout, db);
  return JSON.stringify([task.project, task.id, order]);
}

/** The order's material files, from structured ledger fields only (no path guessed out of free text). */
function materialPaths(db: Database, task: LedgerTask, sent: Pick<SchedulerIntent, "eventSeq">): { role: Role; path: string | null }[] {
  const events = listEvents(db, { project: task.project, target: task.id });
  const report = events.findLast((e) => e.kind === "review" && e.seq < sent.eventSeq)?.data.path;
  const material = events.findLast((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === task.specRev &&
    e.data.round === task.round)?.data.material;
  // task.spec as specPathFor resolves it; an absolute task.spec that is gone stays named, so it reads as a failure, not as absent
  const spec = specPathFor(task, getMeta(db, task.project).docsDir) ?? (task.spec && isAbsolute(task.spec) ? task.spec : null);
  return [{ role: "spec", path: spec },
    ...(report === undefined ? [] : [{ role: "prior_report" as const, path: typeof report === "string" ? report : null }]),
    ...(material === undefined ? [] : [{ role: "fix_strategy" as const, path: typeof material === "string" ? material : null }])];
}

/** One file's bytes now, or why they cannot be read (never skipped). */
function hashFile(path: string | null): { sha256: string } | { error: string } {
  if (!path) return { error: "找不到文件" };
  if (!isAbsolute(path)) return { error: "不是绝对路径" };
  try { return { sha256: sha256(readFileSync(path)) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Freeze one formal review order's materials (once per ticket, before it is sent); a failed write is one diagnostic line. */
export function freezeReviewMaterials(db: Database, task: LedgerTask, intent: SchedulerIntent, plan: OrderPlan, now: number): void {
  try {
    if (getEventByDedup(db, snapshotKey(intent.id))) return;
    const order = normalizedOrder(db, task, intent, plan);
    const files: Item[] = materialPaths(db, task, intent).map((m) => ({ ...m, ...hashFile(m.path) }));
    const digest = `sha256:${sha256(JSON.stringify([sha256(order), files]))}`;
    appendEvent(db, { actor: "scheduler", now, dedupKey: snapshotKey(intent.id) }, { project: task.project, target: task.id, kind: "note",
      text: `审查单材料快照（${files.length} 个文件）`, data: { op: SNAPSHOT_OP, intentId: intent.id, head: intent.head, specRev: intent.specRev,
        round: task.round, digest, order, orderSha256: sha256(order), files } });
  } catch (e) {
    diag(`${task.id} 审查单 ${intent.id} 材料快照没记上（之后不能豁免接续）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The ticket's snapshot as the scheduler wrote it for that very order, or null. */
function frozen(db: Database, task: LedgerTask, sent: SchedulerIntent): LedgerEvent | null {
  const e = getEventByDedup(db, snapshotKey(sent.id));
  return e && e.actor === "scheduler" && e.kind === "note" && e.target === task.id && e.data.op === SNAPSHOT_OP && e.data.intentId === sent.id &&
    e.data.head === sent.head && e.data.specRev === sent.specRev && typeof e.data.digest === "string" && Array.isArray(e.data.files) ? e : null;
}

/** What MODEL records for a refused ticket: its frozen snapshot's digest (no snapshot: a marker no check accepts). */
export const reviewMaterialDigest = (db: Database) => (task: LedgerTask, sent: SchedulerIntent): string =>
  String(frozen(db, task, sent)?.data.digest ?? `nosnapshot:${sent.id}`);

/**
 * Why the ticket's materials are no longer its frozen snapshot, or null. want: the digest MODEL recorded. order: a new order (the
 * exempt ticket) whose own text and material list must equal the snapshot. Every file is re-hashed now.
 */
export const reviewMaterialCheck = (db: Database): MaterialCheck => (task, sent, want, order) => {
  const snap = frozen(db, task, sent);
  if (!snap) return "原派单无材料快照";
  if (snap.data.digest !== want) return "MODEL 记下的材料摘要不是原派单快照";
  if (sha256(normalizedOrder(db, task, order?.intent ?? sent, order ? order.plan : undefined)) !== snap.data.orderSha256) {
    return order ? "新审查单正文与原派单快照不一致" : "审查单正文与原派单快照不一致";
  }
  const items = snap.data.files as Item[];
  const list = (xs: readonly { role: Role; path: string | null }[]) => xs.map((x) => `${x.role}:${x.path ?? "-"}`).join("，");
  const was = list(items), now = list(materialPaths(db, task, order?.intent ?? sent));
  if (was !== now) return `材料清单与原派单快照不一致（原 ${was}；现 ${now}）`;
  for (const it of items) {
    const what = `${ROLE[it.role] ?? it.role} ${it.path ?? "（无路径）"}`;
    if (typeof it.sha256 !== "string") return `${what} 原派单时就读不到（${it.error ?? "无摘要"}），无法证明材料不变`;
    const h = hashFile(it.path);
    if ("error" in h) return `${what} 读取失败（${h.error}）`;
    if (h.sha256 !== it.sha256) return `${what} 内容与原派单快照不一致`;
  }
  return null;
};

/** The refusal kind the owner hears about: Codex's cyber-policy cut vs any other usage-policy refusal. */
export const refusalKind = (evidence: string): "cyber_policy" | "usage_policy" => isCyberPolicy(evidence) ? "cyber_policy" : "usage_policy";
export const informKey = (taskId: string, kind: string): string => `model-refusal-inform:${taskId}:${kind}`;

/** MODEL's recorded plan event → the refusal epoch, or why not (every guard re-read in the writer's transaction). */
function runEpoch(card: ModelWiringCard, planSeq: number, authorized: Placement[]): { event: LedgerEvent; duplicate: boolean } | { error: string } {
  try {
    return beginRefusalEpoch(card.db, { actor: "scheduler", now: card.deps.now() }, card.task.id, planSeq, authorized, reviewMaterialCheck(card.db));
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

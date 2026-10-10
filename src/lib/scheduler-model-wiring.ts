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
 * MODELXW: the scheduler service holds only a read-only ledger handle, so every write here goes through the guarded
 * `ledger scheduler-model-*` CLI under the scheduler identity (manager/ledger-model-cmds.ts), which re-reads its facts in the
 * writer's transaction and calls the same library functions (write* below). A failed write is one stderr line plus, once per card
 * and kind, a ledger note and a PM notice: "拒审接续在本卡不可用". tests/scheduler-model-wiring*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { getIntent } from "./ledger-scheduler.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { SchedulerLeaseLost } from "./scheduler-lease-env.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { createRecoveryRuntimePorts } from "./recovery-runtime-ports.js";
import type { LocalFamilies } from "./scheduler-local-families-config.js";
import type { OrderPlan } from "./scheduler-review-swap.js";
import { hashFile, type Item, materialPaths, normalizedOrder, reviewMaterialCheck, reviewMaterialDigest, sha256, SNAPSHOT_OP, snapshotKey } from "./review-material-check.js";
export { reviewMaterialCheck, reviewMaterialDigest, snapshotKey } from "./review-material-check.js";
import { beginRefusalEpoch } from "./scheduler-sessions.js";
import { classifyModelOutcome, modelOutcomePolicy, type OutcomeInput, type OutcomeRecord, type OutcomeSignal, type RecoveryPolicyPort } from "./scheduler-model-outcome.js";
import type { SessionRef, WorkerObservation } from "./worker-session.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { preserveSessionHistory } from "./scheduler-sessions.js";
import { approvalLapse, EXEMPT_OP, openSafetyHold, RETRY_OP, swapKey } from "./scheduler-review-swap.js";
import { cfgReaderPath } from "./recovery-materials-wiring.js" with { type: "macro" };

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/** The slice of the auto tick's Card this step reads; structural so auto-tick keeps Card private. db is read-only in production. */
export interface ModelWiringCard {
  readonly db: Database;
  readonly task: LedgerTask;
  readonly opts: { pool?: { remote: LocalFamilies } };
  /** manager: the ledger CLI under the scheduler identity (the only write path); notifyPm: the auto tick's PM notice. */
  readonly deps: { now(): number; manager: Manager; notifyPm(task: LedgerTask, text: string): Promise<void> };
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

/**
 * modelOutcome's mode for a project as MODEL reads it (CFG's reader; not installed = observe, broken = off): the supervisor asks it
 * before claiming a reviewer's policy refusal (agent-supervisor-policy.ts refusalYieldsToModel).
 */
export async function modelOutcomeMode(project: string): Promise<"on" | "observe" | "off"> {
  try { return modelOutcomePolicy(await loadPolicy(), project).mode; } catch { return "off"; }
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

/** The four writes this step makes, each through its own `ledger` subcommand; labels name them in the unavailable notice. */
export type WiringWrite = "snapshot" | "outcome" | "epoch" | "inform" | "legacy";
const WRITE_LABEL: Record<WiringWrite, string> = { snapshot: "审查单材料快照", outcome: "模型结果", epoch: "拒审接续 epoch", inform: "owner 告知",
  legacy: "旧拒审单退休" };
export const unavailableKey = (taskId: string, what: WiringWrite): string => `model-wiring-unavailable:${taskId}:${what}`;

type Wrote = { ok: true; r: Record<string, unknown> } | { ok: false; code: string; error: string };
/** One guarded ledger write. A stop / lost lease ends the pass (SchedulerStopped); anything else is an answer, never a throw. */
async function ledgerWrite(card: ModelWiringCard, args: string[]): Promise<Wrote> {
  let r: Record<string, unknown>;
  try { r = await card.deps.manager("ledger", ...args); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof SchedulerLeaseLost) throw new SchedulerStopped(`ledger ${args[0]}: ${e.message}`);
    return { ok: false, code: "threw", error: e instanceof Error ? e.message : String(e) };
  }
  if (r.code === "lease-lost") throw new SchedulerStopped(`ledger ${args[0]}: ${String(r.error)}`);
  return r.ok === true ? { ok: true, r } : { ok: false, code: String(r.code ?? "unknown"), error: String(r.error ?? "没有结果") };
}

/** Writer-side check + append in one immediate transaction (appendEvent nests as a savepoint). */
const atomic = <T>(db: Database, fn: () => T): T => db.transaction(fn).immediate();

/** PM notices of an unavailable write that could not be recorded either: once per process, ledger file, card and kind. */
const toldInMemory = new Set<string>();
/**
 * A write failed: one stderr line, then once per card and kind a ledger note (dedup unavailableKey) and a PM notice saying the
 * refusal continuation is unavailable on this card. The note decides "once"; when it cannot be written either, memory does.
 */
async function unavailable(card: ModelWiringCard, what: WiringWrite, error: string, line = ""): Promise<void> {
  const id = card.task.id, label = WRITE_LABEL[what];
  diag(line ? `${id} ${line}：${error}` : `${id} ${label}没记上（拒审接续在本卡不可用）：${error}`);
  const key = unavailableKey(id, what), text = `[调度引擎] ${id} 拒审接续在本卡不可用：${label}没写进台账（${flat(error).slice(0, 200)}）；` +
    "本卡遇到策略拒审会照旧退人工，请查 scheduler.err 与台账写口";
  const rec = await ledgerWrite(card, ["scheduler-model-inform", id, "--key", key, "--text", text,
    "--data", JSON.stringify({ op: "refusal_wiring_unavailable", kind: "audit", write: what, audience: "pm" })]);
  const mem = `${card.db.filename}\n${card.task.project}\n${key}`;
  const first = rec.ok ? rec.r.duplicate !== true && !toldInMemory.has(mem) : !toldInMemory.has(mem);
  if (!rec.ok) diag(`${id} 「拒审接续不可用」也没记进台账（改为直接通知 PM）：${rec.error}`);
  if (!first) return;
  toldInMemory.add(mem);
  try { await card.deps.notifyPm(card.task, text); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    diag(`${id} 「拒审接续不可用」通知 PM 没发出去（台账${rec.ok ? "已记" : "也没记上"}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What `ledger scheduler-model-outcome` takes: the failed turn as the service saw it; the digest is re-read by the writer. */
export interface OutcomeWrite { intentId: string; failure: Failure; failed: Placement & { agent: string }; authorized: Placement[]; review?: { sessionId: string } }

/**
 * Writer side of `ledger scheduler-model-outcome`: MODEL's record with CFG's policy and REFA's approval port (both read now, in
 * the writer's process), the ticket's frozen-snapshot digest re-read here; recordModelOutcome re-checks inside its transaction.
 */
export async function writeModelOutcome(db: Database, ctx: WriteCtx, input: OutcomeWrite): Promise<OutcomeRecord> {
  const sent = getIntent(db, input.intentId), task = sent && getTask(db, sent.taskId);
  const policy = await loadPolicy();
  const ports = createRecoveryRuntimePorts({ ...(policy ? { policy } : {}), refusalApproval: createRefusalApprovalPort(db),
    onDiag: (d) => diag(`${sent?.taskId ?? input.intentId} ${d.mechanism}：${d.reason}`) });
  const review = input.review && sent && task ? { sessionId: input.review.sessionId, materialDigest: reviewMaterialDigest(db)(task, sent) } : undefined;
  return ports.recordModelOutcome(db, ctx, { intentId: input.intentId, signal: { failure: input.failure }, failed: input.failed,
    authorized: input.authorized, ended: true, ...(review ? { review } : {}) });
}

/**
 * Record the failed turn with MODEL; answers the suffix for the caller's escalate reason ("" = unchanged), or { epoch } when the
 * refusal continuation ran and the card goes on without escalating. Under on, a redispatch plan is named as pending; a safety
 * refusal informs the owner once per card and kind. Every write goes through the ledger CLI (the service's handle is read-only).
 */
export async function modelOutcomeStep(card: ModelWiringCard, sent: SchedulerIntent, ref: SessionRef, failure: Failure): Promise<string | { epoch: string }> {
  const failed = { family: ref.family, machine: machineOf(ref) }, authorized = authorizedFor(card, failed);
  const input: OutcomeWrite = { intentId: sent.id, failure, failed: { ...failed, agent: ref.agent }, authorized,
    ...(ref.role === "reviewer" ? { review: { sessionId: ref.sessionId } } : {}) };
  const got = await ledgerWrite(card, ["scheduler-model-outcome", sent.id, "--data", JSON.stringify(input)]);
  if (!got.ok) {
    await unavailable(card, "outcome", got.error, `意图 ${sent.id} 记模型结果失败，照旧退人工`);
    return "";
  }
  const r = got.r.record as OutcomeRecord;
  if (r.kind === "off") { if (r.diag) diag(`${card.task.id} 模型结果按 off：${r.diag}`); return ""; }
  if (r.kind !== "recorded" || r.mode !== "on") return "";
  const p = r.plan;
  if (p.kind === "retry_same" || p.kind === "exempt_review") {
    const done = await runEpoch(card, r.event.seq, authorized);
    await informOwnerOnce(card, r.event, "error" in done ? null : done.event);
    if (!("error" in done)) return { epoch: `${done.event.text}（台账 #${done.event.seq}${done.duplicate ? "，已执行过" : ""}）` };
    return `；MODEL 计划：${p.kind}（批准 ${p.approvalId}，台账 #${r.event.seq}）未执行：${done.error}`;
  }
  if (r.cls === "safety") {
    await informOwnerOnce(card, r.event, null);
    await ownerActionOnce(card, r.event);
  }
  if (p.kind === "manual") return "";
  return `；MODEL 计划：${p.kind}（→ ${p.to.machine}（${p.to.family}），无现成正式路径），执行路径待 MODELX（台账 #${r.event.seq}，未执行）：${p.reason}`;
}

/** The normalized text of the order about to go out (read only; the service computes it, the writer stores it). */
export const reviewOrderText = (db: Database, task: LedgerTask, intent: SchedulerIntent, plan: OrderPlan): string => normalizedOrder(db, task, intent, plan);

/**
 * Writer side of `ledger scheduler-review-snapshot`: in the writer's transaction re-read the ticket (still a pending review order of
 * this card, head / specRev / round current, its reviewer binding active), then hash the material files and record the snapshot
 * once (dedup snapshotKey). order: the normalized order text the service is about to send.
 */
export function writeReviewSnapshot(db: Database, ctx: WriteCtx, intentId: string, order: string, round: number): { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "审查单材料快照只由调度服务记录");
  return atomic(db, () => {
    const done = getEventByDedup(db, snapshotKey(intentId));
    if (done) return { event: done, duplicate: true };
    const intent = getIntent(db, intentId), task = intent && getTask(db, intent.taskId);
    if (!intent || !task) throw new LedgerError("not_found", "缺原审查单");
    if (intent.action !== "review" || intent.node !== "adversarial_review" || intent.status !== "pending") throw new LedgerError("conflict", "不是待派的审查单");
    if (intent.head !== task.headSHA || intent.specRev !== task.specRev || task.round !== round) throw new LedgerError("conflict", "审查单的 head / specRev / 轮次已不是当前");
    const bound = getSchedulerSession(db, task.id, "reviewer");
    if (!bound || bound.state !== "active") throw new LedgerError("conflict", "本卡没有在用的审查员绑定");
    if (!order.startsWith(JSON.stringify([task.project, task.id]).slice(0, -1))) throw new LedgerError("invalid", "审查单正文不是本卡的");
    const files: Item[] = materialPaths(db, task, intent).map((m) => ({ ...m, ...hashFile(m.path) }));
    const digest = `sha256:${sha256(JSON.stringify([sha256(order), files]))}`;
    return appendEvent(db, { ...ctx, dedupKey: snapshotKey(intent.id) }, { project: task.project, target: task.id, kind: "note",
      text: `审查单材料快照（${files.length} 个文件）`, data: { op: SNAPSHOT_OP, intentId: intent.id, head: intent.head, specRev: intent.specRev,
        round: task.round, digest, order, orderSha256: sha256(order), files } });
  });
}

/**
 * Freeze one formal review order's materials (once per ticket, before it is sent) through `ledger scheduler-review-snapshot`;
 * a failed write is reported (unavailable) and the order still goes out, without a later exemption.
 */
export async function freezeReviewMaterials(card: ModelWiringCard, intent: SchedulerIntent, plan: OrderPlan): Promise<void> {
  let order: string;
  try { order = reviewOrderText(card.db, card.task, intent, plan); } catch (e) {
    return unavailable(card, "snapshot", `审查单 ${intent.id} 正文算不出来：${e instanceof Error ? e.message : String(e)}`);
  }
  const r = await ledgerWrite(card, ["scheduler-review-snapshot", intent.id, "--round", String(card.task.round), "--data", JSON.stringify({ order })]);
  if (!r.ok) await unavailable(card, "snapshot", `审查单 ${intent.id}：${r.error}`, `审查单 ${intent.id} 材料快照没记上（之后不能豁免接续）`);
}

/** The refusal kind the owner hears about: Codex's cyber-policy cut vs any other usage-policy refusal. */
export const refusalKind = (evidence: string): "cyber_policy" | "usage_policy" => isCyberPolicy(evidence) ? "cyber_policy" : "usage_policy";
export const informKey = (taskId: string, kind: string): string => `model-refusal-inform:${taskId}:${kind}`;

/** Guard refusals of the epoch (the writer re-read a fact that no longer holds): the card escalates with why, nothing to report. */
const EPOCH_REFUSALS = new Set(["conflict", "invalid", "not_found", "dedup_mismatch"]);

/** Writer side of `ledger scheduler-refusal-epoch`: beginRefusalEpoch, every guard re-read in its own transaction. */
export const writeRefusalEpoch = (db: Database, ctx: WriteCtx, taskId: string, planSeq: number, authorized: readonly Placement[]) =>
  beginRefusalEpoch(db, ctx, taskId, planSeq, authorized, reviewMaterialCheck(db));

/** MODEL's recorded plan event → the refusal epoch through the ledger CLI, or why not. */
async function runEpoch(card: ModelWiringCard, planSeq: number, authorized: Placement[]): Promise<{ event: LedgerEvent; duplicate: boolean } | { error: string }> {
  const r = await ledgerWrite(card, ["scheduler-refusal-epoch", card.task.id, "--plan-seq", String(planSeq), "--data", JSON.stringify({ authorized })]);
  if (r.ok) return { event: r.r.event as LedgerEvent, duplicate: r.r.duplicate === true };
  if (!EPOCH_REFUSALS.has(r.code)) await unavailable(card, "epoch", r.error, "拒审接续执行失败，退人工");
  return { error: r.error };
}

/**
 * MODELXW 验收线 4 — a refused review ticket sent before snapshots existed (or whose snapshot write failed), on a card handed back
 * to auto: no snapshot means no exemption, ever. Instead the old reviewer binding is formally retired (row and history kept, the old
 * session neither woken nor killed) by a reviewer_swap event marked legacy — no refusal field, so no epoch, no exemption, no merge
 * gate counts it — and the planner sends an ordinary new review on the current head through a new session, which freezes its own
 * snapshot as it goes out. A refusal of that new ticket is MODELX's ordinary first refusal. Only under modelOutcome on, and only
 * when the old turn ended in a provider policy refusal; anything else keeps today's path (MODEL records, the card escalates).
 */
const LEGACY_OP = "reviewer_swap";
const isRefusal = (message: string): boolean => classifyModelOutcome({ failure: { kind: "error", message } })?.cls === "safety";

/** The card's last sent review ticket and its active reviewer binding when they are such a legacy refused pair, or why not. */
function legacyFacts(db: Database, task: LedgerTask): { sent: SchedulerIntent; row: NonNullable<ReturnType<typeof getSchedulerSession>> } | string {
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review") return "卡不在当前规格的自动审查";
  if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id)) return "还有未结意图";
  const sent = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action IN ('dispatch','review') AND status = 'done'
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id) as SchedulerIntent | null;
  if (!sent || sent.action !== "review" || sent.node !== "adversarial_review") return "最近一张单不是已派出的审查单";
  if (getEventByDedup(db, snapshotKey(sent.id))) return "审查单有材料快照（走 MODELX）";
  const row = getSchedulerSession(db, task.id, "reviewer");
  if (!row || row.state !== "active" || row.transport === "peer") return "没有在用的本机审查员绑定";
  const events = listEvents(db, { project: task.project, target: task.id });
  let approval: ReturnType<ReturnType<typeof createRefusalApprovalPort>>;
  try { approval = createRefusalApprovalPort(db)(task.project, task.id); } catch (e) { return `读批准失败：${(e as Error).message}`; }
  const lapse = approvalLapse(db, task, approval?.approvalId);
  if (lapse) return lapse;
  if (openSafetyHold(events)) return "本卡有未处置的安全拒绝留证";
  if (events.some((e) => e.seq > sent.eventSeq && e.kind === "review")) return "审查单已有结论";
  if (events.some((e) => e.seq > sent.eventSeq && e.kind === "scheduler" && e.data.op === LEGACY_OP)) return "审查单之后已换过审查员";
  if (events.some((e) => e.kind === "scheduler" && e.data.op === LEGACY_OP && !!e.data.refusal && e.data.head === task.headSHA &&
    e.data.specRev === task.specRev && e.data.round === task.round)) return "本轮已做过豁免审查";
  if (!events.some((e) => e.seq > sent.eventSeq && e.kind === "scheduler" && e.data.op === "workflow_resume")) return "审查单派出后卡没有交回过自动";
  const bind = events.findLast((e) => e.kind === "scheduler" && e.data.op === "session_bind" && e.data.role === "reviewer" && e.data.sessionId === row.sessionId);
  if (!bind || bind.seq > sent.eventSeq) return "绑定不是派这张审查单时的审查员";
  return { sent, row };
}

/**
 * Writer side of `ledger scheduler-legacy-review-retire`: modelOutcome on (CFG's policy, read now) and the refusal evidence, then in
 * one transaction re-read every legacy fact, write the legacy reviewer_swap (dedup = the swap key of the old ticket, which the
 * reviewer bind accepts in place of a kill receipt) and retire the binding. The old session is left alone.
 */
export async function writeLegacyReviewRetire(db: Database, ctx: WriteCtx, taskId: string, intentId: string, evidence: string,
  write: (ctx: WriteCtx, event: Pick<LedgerEvent, "project" | "target" | "kind" | "text" | "data">) => LedgerEvent): Promise<{ event: LedgerEvent; duplicate: boolean }> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "旧拒审单退休只由调度服务执行");
  if (!isRefusal(evidence)) throw new LedgerError("invalid", "旧审查回合不是提供方策略拒审");
  const task0 = getTask(db, taskId);
  if (!task0) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  if (modelOutcomePolicy(await loadPolicy(), task0.project).mode !== "on") throw new LedgerError("conflict", "modelOutcome 不是 on，不接续旧拒审单");
  return atomic(db, () => {
    const done = getEventByDedup(db, swapKey(intentId));
    if (done) {
      if (done.data.op !== LEGACY_OP || done.data.legacy !== true || done.target !== taskId) throw new LedgerError("dedup_mismatch", "该审查单已有别的换人记录");
      return { event: done, duplicate: true };
    }
    const task = getTask(db, taskId)!, facts = legacyFacts(db, task);
    if (typeof facts === "string") throw new LedgerError("conflict", `不退休旧审查绑定：${facts}`);
    const { sent, row } = facts;
    if (sent.id !== intentId) throw new LedgerError("conflict", "不是本卡最近一张审查单");
    const events = listEvents(db, { project: task.project, target: task.id });
    const plan = events.findLast((e) => (e.data.op === RETRY_OP || e.data.op === EXEMPT_OP) && e.data.intentId === sent.id &&
      e.data.session === row.sessionId && e.data.head === sent.head && e.data.specRev === sent.specRev && e.data.round === task.round);
    const approvalId = createRefusalApprovalPort(db)(task.project, task.id)!.approvalId;
    preserveSessionHistory(db);
    const event = write({ ...ctx, dedupKey: swapKey(sent.id) }, { project: task.project, target: task.id, kind: "scheduler",
      text: `旧审查单 ${sent.id} 被提供方策略拒审且没有材料快照：不唤醒旧会话、不豁免，退休 ${row.agent} 的审查绑定，按当前 head 重派带快照的新审查单`,
      data: { op: LEGACY_OP, legacy: true, intentId: sent.id, fromFamily: row.family, agent: row.agent, sessionId: row.sessionId,
        round: task.round, head: task.headSHA, specRev: task.specRev, sentHead: sent.head, sentSpecRev: sent.specRev,
        approvalId, ...(plan ? { replacedPlanSeq: plan.seq } : {}), evidence: flat(evidence).slice(0, 400) } });
    db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE sessionId = ?").run(sent.id, ctx.now ?? Date.now(), row.sessionId);
    return { event, duplicate: false };
  });
}

/**
 * Service side, from the auto tick's "turn failed" branch before MODEL's record: a legacy refused review ticket (legacyFacts, read on
 * the service's handle) under on is retired through the ledger CLI; answers the outcome text, or null = not legacy / the writer said
 * no (the caller goes on to MODEL as before). A failed write is reported once per card (unavailable).
 */
export async function legacyReviewStep(card: ModelWiringCard, sent: SchedulerIntent, ref: SessionRef, failure: Failure): Promise<string | null> {
  if (ref.role !== "reviewer" || !isRefusal(failure.message)) return null;
  const facts = legacyFacts(card.db, card.task);
  if (typeof facts === "string" || facts.sent.id !== sent.id || facts.row.sessionId !== ref.sessionId) return null;
  if ((await modelOutcomeMode(card.task.project)) !== "on") return null;
  const r = await ledgerWrite(card, ["scheduler-legacy-review-retire", card.task.id, "--intent", sent.id, "--data", JSON.stringify({ evidence: failure.message.slice(0, 4000) })]);
  if (r.ok) return `${(r.r.event as LedgerEvent).text}（台账 #${(r.r.event as LedgerEvent).seq}${r.r.duplicate === true ? "，已执行过" : ""}）`;
  if (!EPOCH_REFUSALS.has(r.code)) await unavailable(card, "legacy", r.error, `旧拒审单 ${sent.id} 退休没记上，照旧退人工`);
  return null;
}

/**
 * MODELXW 验收线 3 — the supervisor hold (agent-supervisor-hold.ts) must not hide a reviewer's provider policy refusal from MODELX
 * under on, even when the supervisor claimed its recovery earlier (under observe / off, before this rule, or before a restart): the
 * observed turn is this order's own, so the refusal goes to the auto tick as observed. observe / off, author turns, other failures:
 * the hold stays as it was.
 */
export async function refusalBypassesHold(db: Database, ref: SessionRef, seen: WorkerObservation): Promise<boolean> {
  if (ref.role !== "reviewer" || seen.state !== "result" || seen.outcome !== "failed" || !isRefusal(seen.failure.message)) return false;
  const task = getTask(db, ref.taskId);
  return !!task && (await modelOutcomeMode(task.project)) === "on";
}

/** Owner / PM notes this step may write: the key names the card, so one card's note never lands on another. */
const NOTE_KEYS = (taskId: string): string[] => [informKey(taskId, "cyber_policy"), informKey(taskId, "usage_policy"), `model-refusal-manual:${taskId}`,
  ...(["snapshot", "outcome", "epoch", "inform", "legacy"] as const).map((w) => unavailableKey(taskId, w))];
const NOTE_OPS = new Set(["refusal_owner_inform", "refusal_owner_manual", "refusal_wiring_unavailable"]);

/** Writer side of `ledger scheduler-model-inform`: one note per key, deduped in the writer's transaction (MODELX's semantics). */
export function writeModelNote(db: Database, ctx: WriteCtx, taskId: string, key: string, text: string, data: Record<string, unknown>): { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "拒审告知只由调度服务记录");
  if (!NOTE_KEYS(taskId).includes(key)) throw new LedgerError("invalid", `不认识的告知键 ${key}`);
  if (!NOTE_OPS.has(String(data.op))) throw new LedgerError("invalid", `不认识的告知 op ${String(data.op)}`);
  return atomic(db, () => {
    const done = getEventByDedup(db, key);
    if (done) return { event: done, duplicate: true };
    const task = getTask(db, taskId);
    if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
    return appendEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind: "note", text: flat(text).slice(0, 1000),
      data: { audience: "owner", ...data } });
  });
}

/** One owner note per key (no push, no buttons), deduped across ticks and restarts; a failed write is reported once. */
async function ownerNoteOnce(card: ModelWiringCard, key: string, text: string, data: Record<string, unknown>): Promise<void> {
  if (getEventByDedup(card.db, key)) return;
  const r = await ledgerWrite(card, ["scheduler-model-inform", card.task.id, "--key", key, "--text", text, "--data", JSON.stringify(data)]);
  if (!r.ok) await unavailable(card, "inform", r.error, "拒审告知 owner 没记上");
}

/** Under on, a safety refusal tells the owner once per card and refusal kind (inform): what ran, or that the card is paused. */
async function informOwnerOnce(card: ModelWiringCard, record: LedgerEvent, epoch: LedgerEvent | null): Promise<void> {
  const kind = refusalKind(String(record.data.evidence ?? "")), id = card.task.id;
  const what = epoch ? `已按 owner 规矩直接换家族审一次：${epoch.text}；提示词和材料不改，新审查员独立判断，它也拒就停人工`
    : "本卡暂停，交 PM / owner 处置";
  await ownerNoteOnce(card, informKey(id, kind), `[调度引擎] ${id} 审查被模型提供方策略拒绝（${kind}）：${what}；原文已留证（台账 #${record.seq}）；` +
    "要按卡挂起用 extra.refusalHold", { op: "refusal_owner_inform", kind: "inform", refusal: kind, recordSeq: record.seq, ...(epoch ? { epochSeq: epoch.seq } : {}) });
}

/** The exempt review was refused too: manual, and the owner gets one note to act on for the card (not per refusal). */
async function ownerActionOnce(card: ModelWiringCard, record: LedgerEvent): Promise<void> {
  const epoch = listEvents(card.db, { project: card.task.project, target: card.task.id })
    .findLast((e) => e.kind === "scheduler" && e.data.op === "reviewer_swap" && !!e.data.refusal && e.seq < record.seq &&
      e.data.head === record.data.head && e.data.specRev === record.data.specRev && e.data.round === record.data.round);
  if (!epoch || (record.data.plan as { kind?: string } | undefined)?.kind !== "manual") return;
  await ownerNoteOnce(card, `model-refusal-manual:${card.task.id}`, `[调度引擎] ${card.task.id} 豁免审查也被拒（台账 #${record.seq}，豁免 #${epoch.seq}）：` +
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

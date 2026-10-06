/**
 * dispatch-recovery-MODELW: the one production caller of MODEL's recordModelOutcome — the auto tick's "turn failed" branch.
 * The record goes through createRecoveryRuntimePorts with REFA's ledger approval port and CFG's recoveryPolicy, loaded at
 * run time from CFG's frozen location (no file = no port, MODEL observes; a broken module = a throwing port, MODEL turns off).
 * The caller always escalates as before; this step only answers a suffix for its reason. "" = today's text exactly: observe /
 * off / none / manual plans and every wiring error (logged as one diagnostic line). Mode on with a redispatch plan appends
 * "MODEL 计划：redispatch …，执行路径待 MODELX" (no formal path re-sends an order yet). A retry_same / exempt_review plan follows a
 * provider safety refusal and is never executed automatically (MODELX boundary: no new session / family / provider to get past a
 * safety decision): the suffix says the card stays paused for PM / owner, and the owner gets one inform note per card and refusal
 * kind. failedReason shortens a long host message so the plan survives the cap. The record is deduped per intent by MODEL's key;
 * the escalate by its own; the inform by card + kind.
 * tests/scheduler-model-wiring*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { createRecoveryRuntimePorts } from "./recovery-runtime-ports.js";
import type { LocalFamilies } from "./scheduler-local-families-config.js";
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

/** Already authorized placements: the bound one first (retry_same needs it), then this machine's allowed families. */
function authorizedFor(card: ModelWiringCard, failed: Placement): Placement[] {
  const families: AuthorFamily[] = card.opts.pool?.remote.localFamilies ?? ["claude", "codex"];
  const out = [failed];
  for (const family of families) if (!out.some((p) => p.family === family && p.machine === "local")) out.push({ family, machine: "local" });
  return out;
}

/** Same ticket window and node = same review materials; a moved head or spec is a new digest (MODEL then holds). */
const materialDigest = (task: LedgerTask, sent: SchedulerIntent): string =>
  `sha256:${createHash("sha256").update(JSON.stringify([task.project, task.id, sent.node, sent.head ?? "", sent.specRev])).digest("hex")}`;

/**
 * Record the failed turn with MODEL; answers the suffix for the caller's escalate reason ("" = unchanged). Under on, a redispatch
 * plan is named as pending, a refusal continuation as paused (never run), each with its ledger seq; a safety refusal informs the owner once.
 */
export async function modelOutcomeStep(card: ModelWiringCard, sent: SchedulerIntent, ref: SessionRef, failure: Failure): Promise<string> {
  let r: ReturnType<ReturnType<typeof createRecoveryRuntimePorts>["recordModelOutcome"]>;
  try {
    const policy = await loadPolicy();
    const ports = createRecoveryRuntimePorts({ ...(policy ? { policy } : {}), refusalApproval: createRefusalApprovalPort(card.db),
      onDiag: (d) => diag(`${card.task.id} ${d.mechanism}：${d.reason}`) });
    const failed = { family: ref.family, machine: machineOf(ref) };
    r = ports.recordModelOutcome(card.db, { actor: "scheduler", now: card.deps.now() }, { intentId: sent.id, signal: { failure },
      failed: { ...failed, agent: ref.agent }, authorized: authorizedFor(card, failed), ended: true,
      ...(ref.role === "reviewer" ? { review: { sessionId: ref.sessionId, materialDigest: materialDigest(card.task, sent) } } : {}) });
  } catch (e) {
    diag(`${card.task.id} 意图 ${sent.id} 记模型结果失败，照旧退人工：${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
  if (r.kind === "off") { if (r.diag) diag(`${card.task.id} 模型结果按 off：${r.diag}`); return ""; }
  if (r.kind !== "recorded" || r.mode !== "on") return "";
  if (r.cls === "safety") informOwnerOnce(card, r.event);
  if (r.plan.kind === "manual") return "";
  const p = r.plan;
  // MODELX boundary: a provider's safety refusal is never retried automatically in a new session, family or provider.
  if (p.kind !== "redispatch") return `；MODEL 计划：${p.kind}（批准 ${p.approvalId}，台账 #${r.event.seq}）——提供方安全拒绝保持暂停：不自动换会话 / 家族 / 提供方重试，待 PM / owner 处置`;
  return `；MODEL 计划：${p.kind}（→ ${p.to.machine}（${p.to.family}），无现成正式路径），执行路径待 MODELX（台账 #${r.event.seq}，未执行）：${p.reason}`;
}

/** The refusal kind the owner hears about: Codex's cyber-policy cut vs any other usage-policy refusal. */
export const refusalKind = (evidence: string): "cyber_policy" | "usage_policy" => isCyberPolicy(evidence) ? "cyber_policy" : "usage_policy";
export const informKey = (taskId: string, kind: string): string => `model-refusal-inform:${taskId}:${kind}`;

/**
 * Under on, a safety refusal tells the owner once per card and refusal kind: an inform note (no push, no buttons) on the ledger,
 * deduped across retries, ticks and restarts. The card itself stays paused; a failed write is one diagnostic line, never a retry.
 */
function informOwnerOnce(card: ModelWiringCard, record: LedgerEvent): void {
  const kind = refusalKind(String(record.data.evidence ?? "")), key = informKey(card.task.id, kind);
  try {
    if (getEventByDedup(card.db, key)) return;
    appendEvent(card.db, { actor: "scheduler", now: card.deps.now(), dedupKey: key }, { project: card.task.project, target: card.task.id, kind: "note",
      text: `[调度引擎] ${card.task.id} 被模型提供方安全策略拒绝（${kind}）：本卡暂停，不自动重试、不换会话 / 家族 / 提供方；原文已留证（台账 #${record.seq}），` +
        "由 PM / owner 处置；要按卡挂起用 extra.refusalHold",
      data: { op: "refusal_owner_inform", kind: "inform", audience: "owner", refusal: kind, recordSeq: record.seq } });
  } catch (e) {
    diag(`${card.task.id} 拒审告知 owner 没记上：${e instanceof Error ? e.message : String(e)}`);
  }
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

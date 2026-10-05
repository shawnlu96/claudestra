/**
 * dispatch-recovery-MODELW: the one production caller of MODEL's recordModelOutcome — the auto tick's "turn failed" branch.
 * The record goes through createRecoveryRuntimePorts with REFA's ledger approval port and CFG's recoveryPolicy, loaded at
 * run time from CFG's frozen location (no file = no port, MODEL observes; a broken module = a throwing port, MODEL turns off).
 * The caller always escalates as before; this step only answers a suffix for its reason. "" = today's text exactly: observe /
 * off / none / manual plans and every wiring error (logged as one diagnostic line). Mode on with a retry_same / exempt_review /
 * redispatch plan appends "MODEL 计划：<kind>（批准 <approvalId>），执行路径待 MODELX": executing these plans (a new reviewer
 * session, an exemption review bound to another family, a redispatch of a sent order) is dispatch-recovery-MODELX, so this card
 * never stops the escalate on a plan no one runs. The record is deduped per intent by MODEL's key; the escalate by its own.
 * tests/scheduler-model-wiring*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
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
 * Record the failed turn with MODEL; answers the suffix for the caller's escalate reason ("" = unchanged). Under on, a
 * retry_same / exempt_review / redispatch plan is named, marked pending MODELX, with its ledger seq (owner flagged when the plan asks).
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
  if (r.kind !== "recorded" || r.mode !== "on" || r.plan.kind === "manual") return "";
  const p = r.plan, owner = p.kind === "exempt_review" && p.notifyOwner ? `；${p.exemption}，按批准需告知 owner` : "";
  const basis = p.kind === "redispatch" ? `→ ${p.to.machine}（${p.to.family}），无现成正式路径` : `批准 ${p.approvalId}`;
  return `；MODEL 计划：${p.kind}（${basis}），执行路径待 MODELX（台账 #${r.event.seq}，未执行）：${p.reason}${owner}`;
}

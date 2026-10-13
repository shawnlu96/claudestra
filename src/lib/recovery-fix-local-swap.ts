/**
 * dispatch-recovery-GATESWAP1 · fixLocalSwap: a fix whose peer-written head has a valid structured P1 and whose order has been stuck
 * for FIX_LOCAL_SWAP_WAIT_MS — the outbound gate refused this window's very material, or the fixed peer (the lease holder) has had no
 * free slot of the head's family — is taken over by this machine's other-family author through the CONV2 other_family chain (lease
 * reclaim, local session, binding receipts). Nothing here writes: the planner, the materials step, the reclaim authority and every
 * runtime effect edge read the one fact below, so they cannot disagree, and nothing fakes a four-round streak.
 * Clocks are ledger events only (the gate's own refusal events; recovery_observe stretch notes for the peer wait), so a restart
 * neither resets nor advances them. Policy: recovery-policy key fixLocalSwap (off / observe / on; default observe).
 * tests/recovery-fix-local-swap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { fixStartReviewFacts } from "./lend-fix-start-review.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { gateBlock } from "./scheduler-dispatch-block.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import type { InventoryQuota } from "./ai-quota.js";
import { attemptKey } from "./intent-attempt.js";
import type { ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";

export const FIX_LOCAL_SWAP_KEY = "fixLocalSwap" as const;
/** PM 定值 1: the same threshold for a gate refusal and for a fixed peer without a slot; no config field. */
export const FIX_LOCAL_SWAP_WAIT_MS = 30 * 60_000;
export const LOCAL_SWAP_PREFIX = "fix-local-swap";
/** Claude has no configured weekly line; a proof needs every live weekly window below this. */
const CLAUDE_WEEKLY_LINE = 90;
const STRETCH = "local-swap-wait";
const GATE_CODE = "dispatch_blocked_gate";
const PEER_CODES: readonly string[] = ["fix_lease_wait", "placement", "placement_pinned"];

type Family = AuthorFamily;
const other = (f: Family): Family => (f === "claude" ? "codex" : "claude");

export interface LocalSwapPorts {
  policy?: RecoveryPolicyPort;
  /** The family's quota snapshot; absent = the inventory reader (ai-quota.ts). */
  quota?: (family: Family) => Promise<InventoryQuota>;
  /** The Codex weekly line for the project; absent = quota-codex-line.ts. */
  codexLine?: (project: string) => number;
  /** Session / worktree lifecycle of the CONV2 chain when the CLI runs it; absent = convergenceLifecycle(). */
  lifecycle?: ConvergenceLifecycle;
}
const ports = new WeakMap<Database, LocalSwapPorts>();
/** Same wiring pattern as setRemoteConvergenceContext: tests and the service inject ports per ledger. */
export const setLocalSwapPorts = (db: Database, p: LocalSwapPorts): void => void ports.set(db, p);
export const localSwapPorts = (db: Database): LocalSwapPorts => ports.get(db) ?? {};
export const localSwapMode = (db: Database, project: string): RecoveryMode => (ports.get(db)?.policy ?? recoveryPolicy)(project, FIX_LOCAL_SWAP_KEY).mode;
export const isLocalSwapIntent = (i: Pick<SchedulerIntent, "id">): boolean => i.id.startsWith(`${LOCAL_SWAP_PREFIX}:`);

/** What the takeover stands on; stored on the materials event and re-read by every later step. */
export interface LocalSwapEvidence {
  key: typeof FIX_LOCAL_SWAP_KEY; source: "gate" | "peer_slot";
  specRev: number; round: number; head: string; window: number;
  /** ts / seq of the event the clock starts at (the first matching refusal, or the stretch's start note) */
  since: number; sinceSeq: number;
  material: string | null; peer: string; fromFamily: Family; family: Family;
  findings: { findingId: string; family: string }[];
}

export interface LocalSwapFact {
  mode: RecoveryMode;
  candidate: LocalSwapEvidence | null;
  /** why there is no candidate, or why a candidate may not act yet (lock); null = ripe or still counting */
  why: string | null;
  ripe: boolean;
  /** peer_slot only: the stretch key the tick must open (no start note yet) and the open stretch to end, if any */
  openKey: string | null; endSeq: number | null;
  /** a scheduler reclaim of this round already happened: the chain continues from its post-reclaim step */
  resumed: boolean;
}
export type SwapSnapshot = PlannerSnapshot & { localSwap?: LocalSwapFact };

/** This machine's author family for the card, only from explicit configuration: never the default runtime or a slot total. */
export function localRuntimeOf(remote: RemotePolicy | null | undefined, target: Family): Family | null {
  if (!remote) return null;
  if (remote.agents) return (remote.agents[target] ?? 0) > 0 ? target : null;
  return remote.localFamilies && remote.localAuthorRuntime ? remote.localAuthorRuntime : null;
}

/** null = a positive weekly proof; unknown, stale, unreadable, over the line or a provider limit are all refusals. */
export function quotaRefusal(q: InventoryQuota, now: number, line: number): string | null {
  if (q.status !== "known") return `额度未知（${q.reason ?? "无快照"}）`;
  if (q.limitReached === true) return "提供方明确已撞限额";
  const weekly = q.windows.filter((w) => w.kind === "weekly" || w.kind === "weekly_scoped");
  const live = weekly.filter((w) => !w.resetPassed && (w.resetsAtMs === null || w.resetsAtMs > now) && typeof w.usedPct === "number" && Number.isFinite(w.usedPct));
  if (!live.length || live.length !== weekly.length) return "周额度读数缺失或已过期，不算正向证明";
  const over = live.find((w) => (w.usedPct as number) >= line);
  return over ? `周额度 ${over.id} 已用 ${over.usedPct}%（线 ${line}%）` : null;
}

export async function localQuotaRefusal(db: Database, project: string, family: Family, now: number): Promise<string | null> {
  const p = localSwapPorts(db);
  try {
    const q = p.quota ? await p.quota(family) : (await (await import("./ai-quota.js")).readInventoryQuota())[family];
    const line = family === "codex" ? (p.codexLine ?? (await import("./quota-codex-line.js")).codexWeeklyLineAt)(project) : CLAUDE_WEEKLY_LINE;
    const why = quotaRefusal(q, now, line);
    return why && `本机 ${family} 没有正向额度证明：${why}`;
  } catch (e) { return `本机 ${family} 额度读不到，不算可用：${(e as Error).message}`; }
}

const stageWindow = (s: PlannerSnapshot): number =>
  s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? 0;

/** The peer-wait stretch key: one clock per round, head, spec, target peer and family. */
export const stretchKey = (e: Pick<LocalSwapEvidence, "specRev" | "round" | "head" | "peer" | "fromFamily">): string =>
  createHash("sha256").update(JSON.stringify([e.specRev, e.round, e.head, e.peer, e.fromFamily])).digest("hex").slice(0, 24);

function stretchNotes(events: readonly LedgerEvent[], since: number): LedgerEvent[] {
  return events.filter((e) => e.seq > since && e.kind === "note" && e.data.op === "recovery_observe" &&
    e.data.mechanism === FIX_LOCAL_SWAP_KEY && e.data.stretch !== undefined);
}

/** The open stretch (its start note) after `since`, or null. */
export function openStretch(events: readonly LedgerEvent[], since: number): LedgerEvent | null {
  const last = stretchNotes(events, since).at(-1);
  return last?.data.stretch === "start" ? last : null;
}
/** The seq the next start note is keyed on: the last stretch note (an end), else the window. */
export const stretchAnchor = (events: readonly LedgerEvent[], since: number): number => stretchNotes(events, since).at(-1)?.seq ?? since;

/** The gate clock: the first refusal in this window whose recorded material is the current one. */
function gateSince(s: PlannerSnapshot, window: number): { ts: number; seq: number; material: string } | null {
  const b = gateBlock(s.task, s.events, s.gate);
  if (b?.state !== "blocked" || b.material === "unknown") return null;
  const first = s.events.find((e) => e.kind === "scheduler" && e.data.op === "gate_refused" && e.seq > window &&
    e.data.window === window && e.data.round === s.task.round && e.data.material === b.material);
  return first ? { ts: first.ts, seq: first.seq, material: b.material } : null;
}

/** The fixed peer's own view says: authorized, reachable, but zero free slots of the head's family (not a lock, quota or outage). */
function peerNoSlot(s: PlannerSnapshot, peer: string, family: Family): boolean {
  const p = s.pool?.peers.find((x) => x.peer === peer);
  const v2 = p?.v2;
  if (!p || !v2 || v2.why || !v2.roles.includes("write") || !s.pool?.repo || !v2.repos.some((r) => r.toLowerCase() === s.pool!.repo!.toLowerCase())) return false;
  return (v2.slots[family] ?? 0) <= 0;
}

function locksBusy(s: PlannerSnapshot): boolean {
  const globs = s.fileGlobs.map(resourceKey);
  return globs.includes(null) || s.heldResources.some((h) => h.taskId !== s.task.id && globs.some((g) => resourcesOverlap(g!, h.resource)));
}

/** A scheduler reclaim by a local-swap intent of this round / head / spec: its evidence continues the chain. */
export function priorLocalReclaim(events: readonly LedgerEvent[], t: { specRev: number; round: number; headSHA: string | null }): LedgerEvent | null {
  return events.findLast((e) => e.kind === "scheduler" && e.data.op === "fix_strategy_reclaim" && typeof e.data.intentId === "string" &&
    e.data.intentId.startsWith(`${LOCAL_SWAP_PREFIX}:`) && e.data.round === t.round && e.data.specRev === t.specRev && e.data.head === t.headSHA) ?? null;
}

const none = (mode: RecoveryMode, why: string): LocalSwapFact => ({ mode, candidate: null, why, ripe: false, openKey: null, endSeq: null, resumed: false });

/**
 * The one eligibility read (pure over the auto snapshot). manual / observe workflows, stages other than fix, a head this machine
 * wrote, a lease already ended (PM's reclaim included: not in the first batch), an implicit runtime and every wait that is not a
 * gate block or a slotless fixed peer are no candidate. A peer stretch without a start note is a candidate still counting.
 */
export function localSwapFact(s: PlannerSnapshot, mode: RecoveryMode, now: number): LocalSwapFact {
  const end = (why: string, seq: number | null = null): LocalSwapFact => ({ ...none(mode, why), endSeq: seq });
  const window = stageWindow(s);
  const open = openStretch(s.events, window);
  if (mode === "off") return none(mode, "fixLocalSwap 是 off");
  if (!s.workflow || s.workflow.mode !== "auto") return end(`流程 ${s.workflow?.mode ?? "无"}：manual / observe 卡不由本键接手`, open?.seq);
  if (s.task.stage !== "fix" || !s.task.headSHA) return end("不在 fix 阶段", open?.seq);
  const read = fixStartReviewFacts(s.task, s.events);
  const p1 = read.kind === "facts" ? read.facts.findings.filter((f) => f.severity === "P1") : [];
  if (!p1.length) return end("没有本轮有效的结构化 P1 审查事实", open?.seq);
  if (s.events.some((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === s.task.specRev && e.data.round === s.task.round)) {
    return end("本轮已执行过修复策略（换会话 / 换家族），不再切换", open?.seq);
  }
  const fromFamily = s.remoteAuthorFamily ?? null;
  const resumedBy = priorLocalReclaim(s.events, s.task);
  const findings = p1.map((f) => ({ findingId: f.findingId, family: f.family }));
  if (resumedBy && fromFamily) {
    const family = other(fromFamily);
    const base = { key: FIX_LOCAL_SWAP_KEY, specRev: s.task.specRev, round: s.task.round, head: s.task.headSHA, window, findings, fromFamily, family };
    return { mode, candidate: { ...base, source: resumedBy.data.source === "peer_slot" ? "peer_slot" : "gate", since: resumedBy.ts, sinceSeq: resumedBy.seq,
      material: null, peer: String(resumedBy.data.peer) }, why: null, ripe: true, openKey: null, endSeq: null, resumed: true };
  }
  if (!fromFamily) return end("当前 head 不是 peer 交付（本机写的 head 不换家族）", open?.seq);
  const peer = s.pool?.writeLeasePeer ?? null;
  if (!peer) return end("写租约不在 peer 上（已结束 / PM 已收回 / 读不到）：不接手", open?.seq);
  const family = other(fromFamily);
  const local = localRuntimeOf(s.pool?.remote, family);
  if (local !== family) return end(`本机作者运行时${local ? `是 ${local}` : "未明确配置"}，不是 ${family}`, open?.seq);
  const base = { key: FIX_LOCAL_SWAP_KEY, specRev: s.task.specRev, round: s.task.round, head: s.task.headSHA, window, peer, fromFamily, family, findings };
  const gate = gateSince(s, window);
  let candidate: LocalSwapEvidence, openKey: string | null = null, endSeq: number | null = null;
  if (gate) {
    candidate = { ...base, source: "gate", since: gate.ts, sinceSeq: gate.seq, material: gate.material };
    endSeq = open?.seq ?? null;
  } else if (peerNoSlot(s, peer, fromFamily)) {
    const key = stretchKey(base);
    const mine = open && open.data.key === key ? open : null;
    if (!mine) { openKey = key; endSeq = open?.seq ?? null; }
    candidate = { ...base, source: "peer_slot", since: mine?.ts ?? now, sinceSeq: mine?.seq ?? 0, material: null };
    if (!mine) return { mode, candidate, why: "固定 peer 无空位：等待起点未记，先记再计时", ripe: false, openKey, endSeq, resumed: false };
  } else return end("修复单没有卡在外发闸或固定 peer 无空位上", open?.seq);
  const lock = locksBusy(s) ? "文件锁被别的卡占着（不算无空位，不接手）" : null;
  return { mode, candidate, why: lock, ripe: !lock && now - candidate.since >= FIX_LOCAL_SWAP_WAIT_MS, openKey, endSeq, resumed: false };
}

/** The action key observe and the intent dedup bind to: card, spec, round, start head, P1 identities, action. */
export function takeoverKey(taskId: string, e: Pick<LocalSwapEvidence, "specRev" | "round" | "head" | "findings">): string {
  const ids = e.findings.map((f) => f.findingId).sort().join(",");
  return `take:${createHash("sha256").update(JSON.stringify([taskId, e.specRev, e.round, e.head, ids, "local_swap"])).digest("hex").slice(0, 32)}`;
}

/**
 * Planner hook (fix-strategy-plan.ts planConvergence): under on, a ripe candidate turns the gate / placement wait into the CONV2
 * fix_swap intent, keyed on card + round so a repeat tick, refusal or restart is the same intent. Round cap, dispute, escalation
 * and every non-wait decision stay the base planner's; a resumed chain is re-planned whatever the base says.
 */
export function localSwapPlan(s: SwapSnapshot, decision: PlannerDecision, born: number, observedOnly: boolean): PlannerDecision | null {
  const f = s.localSwap;
  if (!f?.candidate || !f.ripe || f.mode !== "on" || s.task.stage !== "fix") return null;
  if (!f.resumed) {
    if (decision.kind !== "wait") return null;
    if (f.candidate.source === "gate" ? decision.code !== GATE_CODE : !PEER_CODES.includes(decision.code)) return null;
  } else if (decision.kind === "escalate") return null;
  return { kind: "intent", id: attemptKey(`${LOCAL_SWAP_PREFIX}:s${born}:r${s.task.round}`, s.task.id, s.intents), node: "fix", action: "fix_swap",
    recipient: null, resources: [`task:s${born}`], observedOnly,
    reason: `本机 ${f.candidate.family} 接手修复（${f.candidate.source === "gate" ? "外发闸拒收本窗口材料" : `固定 peer ${f.candidate.peer} 无 ${f.candidate.fromFamily} 空位`}超过 ` +
      `${FIX_LOCAL_SWAP_WAIT_MS / 60_000} 分钟）；经 CONV2 收租约，原文修复单只给本机；先复现测试失败再修到通过，交付说明写测试名` };
}

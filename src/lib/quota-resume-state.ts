/** Durable per-channel recovery: only acknowledged delivery or observed target facts settle a hit. */
import type { Wall, WallRecovery, WallAgentHit, WallState } from "./quota-wall.js";
import { wallResumeText } from "./quota-wall-notice.js";

export interface ResumeIdentity { sessionId: string; taskKey: string }
export type ResumeTarget =
  | { kind: "ready"; identity: ResumeIdentity }
  | { kind: "cancelled" | "unknown"; reason: string };
type ResumeResult = boolean | "held" | "unknown" | "cancelled";
export interface ResumeRequest { identity: ResumeIdentity; messageId: string }
type ResumeStatus = "pending" | "sending" | "unknown" | "sent" | "held" | "running" | "woken" | "cancelled";
export interface ResumeProgress {
  status: ResumeStatus;
  attempts: number;
  nextAt?: number;
  offline?: boolean;
  messageId?: string;
  reason?: string;
}
export interface ResumeDeps {
  now(): number;
  newId(): string;
  /** Production always supplies this port; absent only in older synthetic adapters. */
  resolveTarget?(channelId: string, agent: string): Promise<ResumeTarget>;
  connected?(channelId: string): boolean;
  mainTurnBusy(channelId: string, agent: string): Promise<boolean>;
  resume(channelId: string, agent: string, text: string, afterTurn?: boolean, request?: ResumeRequest): Promise<ResumeResult>;
  log(msg: string): void;
}
export const sameResumeIdentity = (a: ResumeIdentity, b: ResumeIdentity): boolean => a.sessionId === b.sessionId && a.taskKey === b.taskKey;
export const resumeSettled = (p?: ResumeProgress): boolean => !!p && ["sent", "held", "running", "woken", "cancelled"].includes(p.status);

/** A missing binding may never be acquired later: it could be a new task on the same named window. */
async function checkResumeTarget(d: ResumeDeps, cid: string, hit: WallAgentHit): Promise<ResumeTarget | null> {
  if (!d.resolveTarget) return null;
  try {
    const target = await d.resolveTarget(cid, hit.agent);
    if (target.kind !== "ready") return target;
    if (!hit.identity) return { kind: "unknown", reason: "unbound_hit" };
    return sameResumeIdentity(hit.identity, target.identity) ? target : { kind: "cancelled", reason: "target_replaced" };
  } catch (e) {
    d.log(`额度恢复 ${hit.agent}：身份失读，保留待核：${(e as Error).message}`);
    return { kind: "unknown", reason: "identity_unreadable" };
  }
}

const retryAt = (now: number, attempts: number): number => now + Math.min(300_000, 15_000 * 2 ** Math.min(5, Math.max(0, attempts - 1)));
const add = (list: string[] = [], name: string): string[] => list.includes(name) ? list : [...list, name];

/** Keep legacy summary arrays for notices, but deduplicate and settle by channel plus the persisted hit identity. */
function settledRecovery(r: WallRecovery, hit: WallAgentHit, p: ResumeProgress): WallRecovery {
  if (p.status === "sent") return { ...r, resumed: add(r.resumed, hit.agent) };
  if (p.status === "held") return { ...r, held: add(r.held, hit.agent) };
  if (p.status === "running") return { ...r, running: add(r.running, hit.agent) };
  return r;
}

export interface ResumeRun {
  deps: ResumeDeps;
  /** null once a different wall takes over; every await is followed by this check before saving. */
  current(): Wall | null;
  save(patch: Partial<Wall>): boolean;
  woken(channelId: string): boolean;
  flushed: ReadonlySet<string>;
}

function commit(run: ResumeRun, cid: string, hit: WallAgentHit, p: ResumeProgress): boolean {
  const w = run.current();
  if (!w) return false;
  // Real activity can remove the hit while delivery awaits. Never resurrect its old plan.
  if (w.hits[cid]?.at !== hit.at) return true;
  const resumeStates = { ...w.resumeStates, [cid]: p };
  // Old synthetic adapters have no identity port and use the summary arrays as their persisted terminal contract.
  if (!run.deps.resolveTarget && ["sent", "held", "running"].includes(p.status)) delete resumeStates[cid];
  return run.save({ resumeStates, recovery: settledRecovery(w.recovery!, hit, p) });
}

async function attempt(run: ResumeRun, cid: string, hit: WallAgentHit, p: ResumeProgress): Promise<void> {
  const d = run.deps;
  const target = await checkResumeTarget(d, cid, hit);
  if (!run.current() || run.current()!.hits[cid]?.at !== hit.at) return;
  if (target?.kind === "cancelled") return void commit(run, cid, hit, { ...p, status: "cancelled", reason: target.reason });
  if (target?.kind === "unknown") return void commit(run, cid, hit, { ...p, reason: target.reason, nextAt: retryAt(d.now(), p.attempts) });
  if (p.status === "sending" || p.status === "unknown") {
    commit(run, cid, hit, { ...p, status: "unknown", reason: "delivery_unconfirmed" });
    return; // A crash / transport error may have sent it; repeating would invent exactly-once delivery.
  }
  if (run.woken(cid)) return void commit(run, cid, hit, { ...p, status: "woken" });
  let running: boolean;
  try { running = await d.mainTurnBusy(cid, hit.agent); }
  catch (e) {
    d.log(`额度恢复 ${hit.agent}：回合状态失读，保留待核：${(e as Error).message}`);
    commit(run, cid, hit, { ...p, reason: "turn_unreadable", nextAt: retryAt(d.now(), p.attempts) });
    return;
  }
  if (!run.current() || run.current()!.hits[cid]?.at !== hit.at) return;
  const rechecked = await checkResumeTarget(d, cid, hit);
  if (!run.current() || run.current()!.hits[cid]?.at !== hit.at) return;
  if (rechecked && rechecked.kind !== "ready") {
    commit(run, cid, hit, { ...p, status: rechecked.kind === "cancelled" ? "cancelled" : "pending", reason: rechecked.reason });
    return;
  }
  if (running && !run.flushed.has(cid)) return void commit(run, cid, hit, { ...p, status: "running" });
  const sending: ResumeProgress = { status: "sending", attempts: p.attempts + 1, messageId: d.newId() };
  if (!commit(run, cid, hit, sending)) return;
  let result: ResumeResult;
  try {
    result = await d.resume(cid, hit.agent, wallResumeText(hit.at, hit.error), running,
      target?.kind === "ready" ? { identity: target.identity, messageId: sending.messageId! } : undefined);
  } catch (e) {
    d.log(`额度恢复 ${hit.agent}：投递结果不明，保留待核：${(e as Error).message}`);
    result = "unknown";
  }
  const status: ResumeStatus = result === true ? "sent" : result === "held" ? "held" : result === false ? "pending" : result;
  commit(run, cid, hit, { ...sending, status, ...(result === false ? { reason: "not_delivered", offline: d.connected?.(cid) === false, nextAt: retryAt(d.now(), sending.attempts) } : {}) });
}

/** Persist each result before advancing; offline targets retain bounded retry without replaying successful or held messages. */
export async function runQuotaResumes(run: ResumeRun): Promise<void> {
  const w = run.current();
  if (!w) return;
  const legacy = new Set([...w.recovery!.resumed, ...(w.recovery!.held ?? []), ...w.recovery!.running]);
  for (const [cid, hit] of Object.entries(w.hits).sort((a, b) => a[1].at - b[1].at)) {
    const cur = run.current();
    if (!cur) return;
    const p = cur.resumeStates?.[cid];
    if (resumeSettled(p) || (!p && legacy.has(hit.agent))) continue;
    // A real offline -> connected transition bypasses the old deadline once; connected transport failures keep backoff.
    if ((p?.nextAt ?? 0) > run.deps.now() && !(p?.offline && run.deps.connected?.(cid))) continue;
    await attempt(run, cid, hit, p ?? { status: "pending", attempts: 0 });
  }
  const cur = run.current();
  if (!cur) return;
  const settledNames = new Set([...cur.recovery!.resumed, ...(cur.recovery!.held ?? []), ...cur.recovery!.running]);
  const complete = Object.entries(cur.hits).every(([cid, hit]) => resumeSettled(cur.resumeStates?.[cid])
    || (!cur.resumeStates?.[cid] && settledNames.has(hit.agent)));
  if (complete) run.save({ recovery: { ...cur.recovery!, step: "done" } });
}

/** Carry the binding with held envelopes so the normal delivery guard can recheck it after a bridge restart. */
export function quotaResumeMessageId(request: ResumeRequest): string {
  return `wall_resume.${Buffer.from(JSON.stringify(request.identity)).toString("base64url")}.${request.messageId}`;
}

export function quotaResumeIdentity(messageId: string): ResumeIdentity | null {
  try {
    const parts = messageId.split(".");
    if (parts.length !== 3 || parts[0] !== "wall_resume") return null;
    const x = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return x && typeof x.sessionId === "string" && x.sessionId && typeof x.taskKey === "string" ? x : null;
  } catch {
    return null; // A malformed or legacy unbound envelope cannot prove which session may receive it.
  }
}

/** Upgrade old done records which never accounted for a failed/offline target; a notification stamp is not delivery evidence. */
export function repairQuotaRecovery(s: WallState): WallState {
  const w = s.wall, r = w?.recovery;
  if (!w?.exit || r?.step !== "done") return s;
  const done = new Set([...r.resumed, ...(r.held ?? []), ...r.running]);
  if (Object.entries(w.hits).every(([cid, h]) => resumeSettled(w.resumeStates?.[cid])
    || (!w.resumeStates?.[cid] && (done.has(h.agent))))) return s;
  const next = structuredClone(s);
  next.wall!.recovery!.step = "resume";
  delete next.wall!.recoveredNotifiedAt;
  return next;
}

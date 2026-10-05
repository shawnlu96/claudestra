/**
 * 决定过期后的再提示（dispatch-recovery-ASKR）：过期 = 未批准，原卡 / 原按钮 / 原授权一律不复活、原过期记录不改；
 * owner 有可验证的活跃证据时，按原请求语义开一张新卡（新 id、授权类重绑定出新 hash），每条过期 ask 至多再提示一次；
 * 没有活跃证据就等下一次扫描，不猜在线。owner 删过 / 隐藏过 / 暂停了 / 答过一部分、发起 agent 已重新问过的，永不再提示。
 * 开关与阈值来自注入的策略 port（CFG 的 recoveryPolicy 形状）；缺 port 按 observe：只记日志、无副作用。
 * 并发 / 重复 tick / 重启：dedupKey 唯一 + 写锁内复核（openAskFull.beforeWrite），同一条最多开出一张。单测 tests/ask-recovery.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bindHash } from "./ask-bind.js";
import { getAsk, listAsks, openAskFull, type Ask, type NewAsk } from "./ledger-asks.js";

type RecoveryMode = "on" | "observe" | "off";
interface RecoveryPolicy {
  mode: RecoveryMode;
  /** 过期后多久内还能再提示；null = owner 没设，按原卡有效期那么长 */
  manualAfterMs: number | null;
}
/** CFG 的 recoveryPolicy(project, mechanism) 的窄形：这里只读 askReminder 一项 */
type RecoveryPolicyPort = (project: string, mechanism: "askReminder") => RecoveryPolicy;
/** owner 是否活跃：只认可验证的活动（心跳、动作、配置的时段），null = 没有证据 */
type OwnerActivity = { active: boolean; evidence: string } | null;
type OwnerActivityPort = (project: string, now: number) => OwnerActivity | Promise<OwnerActivity>;

export interface ReminderPorts {
  policy?: RecoveryPolicyPort;
  ownerActive?: OwnerActivityPort;
  /** 发起 agent 还在（不在的再提示只会落到没人收的地方）；缺 = 不知道 → 等 */
  askerLive?: (a: Ask) => boolean | Promise<boolean>;
  /** owner 对这个项目 / agent 暂停了再提示（缺 = 没暂停） */
  paused?: (a: Ask) => boolean;
}

/** 扫描回看的上限：比最长的 ask 有效期（7 天）略长，只是查询边界，不是策略阈值 */
const SCAN_BACK_MS = 8 * 24 * 3_600_000;
const KINDS = new Set(["decide", "authorize", "owner_action"]);
/** 原 extra 里答复路由要用的键；状态标记（dismissed / hidden / fp …）不带过去 */
const CARRY_EXTRA = ["parent", "parentChannelId", "files"];

export const reminderDedupKey = (origId: string): string => `ask-remind:${origId}`;
export const isReminder = (a: Pick<Ask, "extra">): boolean => typeof a.extra?.recoveryOf === "string";

function policyOf(port: RecoveryPolicyPort | undefined, project: string): RecoveryPolicy {
  if (!port) return { mode: "observe", manualAfterMs: null };
  try {
    return port(project, "askReminder");
  } catch (e) {
    console.error(`⚠️ askReminder 策略读取失败（${project}），按 off: ${(e as Error).message}`);
    return { mode: "off", manualAfterMs: null };
  }
}

/** 同一 agent、同一 askKey、比原卡晚开的（agent 重新问过，或那张已被 owner 删 / 答），或已开过的再提示 */
function laterAsks(db: Database, a: Ask): Ask[] {
  if (!a.fromAgent) return [];
  return listAsks(db, { fromAgent: a.fromAgent }).filter((x) => x.id !== a.id && x.createdAt >= a.createdAt &&
    (x.dedupKey === reminderDedupKey(a.id) || (!!a.askKey && x.askKey === a.askKey)));
}

/** 永久不再提示的理由；null = 还有资格（是否现在开另看 owner 活跃） */
function skipReason(a: Ask, later: Ask[], now: number, manualAfterMs: number | null): string | null {
  if (a.state !== "expired") return `state=${a.state}`;
  if (a.source !== "reply" || !a.fromAgent) return "not an agent reply ask";
  if (!KINDS.has(a.kind)) return `kind=${a.kind}`;
  if (a.blocking !== true) return "not blocking";
  if (isReminder(a)) return "already a reminder (one per round)";
  if (a.answer) return "owner answered part of it";
  if (a.extra.hidden || a.extra.dismissed) return "owner hid / deleted it";
  if (later.some((x) => x.dedupKey === reminderDedupKey(a.id))) return "reminder already opened";
  if (later.length) return "agent asked again with the same key";
  const window = manualAfterMs ?? Math.max(0, a.expiresAt - a.createdAt);
  if (now - a.updatedAt > window) return "reminder window passed";
  return null;
}

/** 按原请求语义的新卡：同发起 agent / 频道 / 选项 / key；授权类重绑定（version 带上原 id → 新 hash，旧 hash 对新卡无效） */
function reminderDraft(a: Ask, now: number): NewAsk {
  const extra: Record<string, unknown> = { recoveryOf: a.id };
  for (const k of CARRY_EXTRA) if (a.extra[k] !== undefined) extra[k] = a.extra[k];
  const draft: NewAsk = {
    project: a.project, source: "reply", kind: a.kind, title: a.title, fromAgent: a.fromAgent, fromChannelId: a.fromChannelId,
    itemId: a.itemId, taskId: a.taskId, blocking: a.blocking, urgency: a.urgency, context: a.context, body: a.body, options: a.options,
    allowText: a.allowText, kindHint: a.kindHint, chatId: a.chatId, threadId: a.threadId, expiresAt: now + Math.max(60_000, a.expiresAt - a.createdAt),
    extra, askKey: a.askKey, dedupKey: reminderDedupKey(a.id),
  };
  if (a.bind && a.fromAgent) {
    const { paramsHash: _old, ...b } = a.bind;
    const rebound = { ...b, version: `${b.version ?? ""}#remind:${a.id}` };
    draft.bind = { ...rebound, paramsHash: bindHash(rebound, a.fromAgent) };
  }
  return draft;
}

export type ReminderOutcome =
  | { id: string; result: "skip" | "wait"; reason: string }
  | { id: string; result: "observe"; evidence: string }
  | { id: string; result: "opened"; reminder: Ask; evidence: string };

/** 写锁内复核：原卡仍是 expired 且没被改过、没有更晚的同 key / 已开的再提示（扫描与开卡之间别的连接动过就放弃） */
function recheck(db: Database, a: Ask, now: number, manualAfterMs: number | null): void {
  const cur = getAsk(db, a.id);
  const why = !cur || cur.updatedAt !== a.updatedAt ? "original changed" : skipReason(cur, laterAsks(db, cur), now, manualAfterMs);
  if (why) throw new ReminderAbort(why);
}
class ReminderAbort extends Error {}

/** 判定一条过期 ask 并（on 时）开再提示卡；不抛：库忙 / 复核失败都算 wait / skip，下一次扫描再看 */
export async function remindOne(db: Database, a: Ask, ports: ReminderPorts, now: number): Promise<ReminderOutcome> {
  const pol = policyOf(ports.policy, a.project);
  if (pol.mode === "off") return { id: a.id, result: "skip", reason: "mode=off" };
  const skip = skipReason(a, laterAsks(db, a), now, pol.manualAfterMs);
  if (skip) return { id: a.id, result: "skip", reason: skip };
  if (ports.paused?.(a)) return { id: a.id, result: "skip", reason: "paused by owner" };
  const act = ports.ownerActive ? await ports.ownerActive(a.project, now) : null;
  if (!act) return { id: a.id, result: "wait", reason: "no owner activity evidence" };
  if (!act.active) return { id: a.id, result: "wait", reason: `owner not active (${act.evidence})` };
  if (!ports.askerLive || !(await ports.askerLive(a))) return { id: a.id, result: "wait", reason: "asker not known to be live" };
  if (pol.mode === "observe") return { id: a.id, result: "observe", evidence: act.evidence };
  try {
    const r = openAskFull(db, reminderDraft(a, now), now, { beforeWrite: () => recheck(db, a, now, pol.manualAfterMs) });
    if (r.existed) return { id: a.id, result: "skip", reason: "reminder already opened" };
    return { id: a.id, result: "opened", reminder: r.ask, evidence: act.evidence };
  } catch (e) {
    if (e instanceof ReminderAbort) return { id: a.id, result: "skip", reason: e.message };
    return { id: a.id, result: "wait", reason: `write failed: ${(e as Error).message}` };
  }
}

/** 过期扫描之后调：近期过期的 reply 类逐条判定。返回每条的结果（调用方据此发 SSE / 通知发起方 / 记 observe 日志） */
export async function sweepReminders(db: Database, ports: ReminderPorts, now = Date.now()): Promise<ReminderOutcome[]> {
  const out: ReminderOutcome[] = [];
  for (const a of listAsks(db, { states: ["expired"], source: "reply", closedSince: now - SCAN_BACK_MS })) {
    if (!KINDS.has(a.kind) || a.blocking !== true || isReminder(a)) continue;
    out.push(await remindOne(db, a, ports, now));
  }
  return out;
}

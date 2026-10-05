/**
 * 决定过期后的再提示（dispatch-recovery-ASKR）：过期 = 未批准，原卡 / 原按钮 / 原授权一律不复活、原过期记录不改；
 * owner 有可验证的活跃证据时，按原请求语义开一张新卡（新 id、授权类重绑定出新 hash），每条过期 ask 至多再提示一次；
 * 没有活跃证据就等下一次扫描，不猜在线。owner 删过 / 隐藏过 / 暂停了 / 答过一部分、发起 agent 已重新问过的，永不再提示。
 * 开关与阈值来自注入的策略 port（CFG 的 recoveryPolicy 形状）；缺 port 按 observe：只记日志、无副作用。manualAfterMs=null = owner 没设
 * 停止等待的期限 → 一直等（不拿原卡有效期顶替：审批有效期不是恢复等待期限）。
 * 并发 / 重复 tick / 重启：dedupKey 唯一 + 写锁内复核（openAskFull.beforeWrite：原卡、去重、暂停、策略仍是 on、owner 仍活跃），同一条最多开出一张；
 * owner 活跃最后问（之后到写入不再 await），同步 port 在写锁内再问一次，证据没了就 wait。
 * 通知：新卡落库时带 remindNotice=pending，发完 SSE / 告诉发起方才记 done；没发完（批里别条出错、进程重启）的由 pendingReminderNotices 下次重放，
 * 重放同样过闸（noticeBlocker：策略 on、没暂停、owner 有活跃证据），不满足就留着待办等，不推、不告诉发起方 owner 在线。
 * 单测 tests/ask-recovery.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bindHash } from "./ask-bind.js";
import { getAsk, listAsks, openAskFull, patchAsk, type Ask, type NewAsk } from "./ledger-asks.js";

type RecoveryMode = "on" | "observe" | "off";
interface RecoveryPolicy {
  mode: RecoveryMode;
  /** 过期后多久内还能再提示；null = owner 没设，不设期限（一直等活跃证据） */
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
  /** owner 对这个项目 / agent 暂停了再提示（缺 = 没暂停）；同步，写锁内还会再问一次 */
  paused?: (a: Ask) => boolean;
}

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
  if (manualAfterMs !== null && now - a.updatedAt > manualAfterMs) return "reminder window passed";
  return null;
}

/** 按原请求语义的新卡：同发起 agent / 频道 / 选项 / key；授权类重绑定（version 带上原 id → 新 hash，旧 hash 对新卡无效） */
function reminderDraft(a: Ask, now: number): NewAsk {
  const extra: Record<string, unknown> = { recoveryOf: a.id, remindNotice: "pending" };
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

/** owner 活跃证据不成立的理由；null = 有证据且活跃 */
const inactiveReason = (act: OwnerActivity): string | null =>
  !act ? "no owner activity evidence" : !act.active ? `owner not active (${act.evidence})` : null;

/**
 * 写锁内复核：原卡仍是 expired 且没被改过、没有更晚的同 key / 已开的再提示、owner 没在这期间暂停、策略仍是 on
 * （扫描与开卡之间别的连接动过、或等活跃 / 发起方查询时 owner 暂停 / 关了，就放弃）；
 * owner 活跃 port 是同步的就在锁内再问一次（证据没了 → wait）；异步的用刚 resolve 的那次（之后到这里没有 await）
 */
function recheck(db: Database, a: Ask, ports: ReminderPorts, now: number): void {
  const pol = policyOf(ports.policy, a.project);
  const cur = getAsk(db, a.id);
  const why = pol.mode !== "on" ? `mode=${pol.mode}`
    : !cur || cur.updatedAt !== a.updatedAt ? "original changed"
    : ports.paused?.(cur) ? "paused by owner"
    : skipReason(cur, laterAsks(db, cur), now, pol.manualAfterMs);
  if (why) throw new ReminderAbort(why);
  const act = ports.ownerActive?.(a.project, now);
  if (act instanceof Promise) return void act.catch(() => {});
  const inactive = inactiveReason(act ?? null);
  if (inactive) throw new ReminderWait(inactive);
}
class ReminderAbort extends Error {}
class ReminderWait extends Error {}

/** 判定一条过期 ask 并（on 时）开再提示卡；不抛：库忙 / 复核失败都算 wait / skip，下一次扫描再看 */
export async function remindOne(db: Database, a: Ask, ports: ReminderPorts, now: number): Promise<ReminderOutcome> {
  const pol = policyOf(ports.policy, a.project);
  if (pol.mode === "off") return { id: a.id, result: "skip", reason: "mode=off" };
  const skip = skipReason(a, laterAsks(db, a), now, pol.manualAfterMs);
  if (skip) return { id: a.id, result: "skip", reason: skip };
  if (ports.paused?.(a)) return { id: a.id, result: "skip", reason: "paused by owner" };
  if (!ports.askerLive || !(await ports.askerLive(a))) return { id: a.id, result: "wait", reason: "asker not known to be live" };
  // owner 活跃放最后：从拿到证据到写锁内复核之间不再 await，别的查询期间 owner 走了不会拿旧证据开卡
  const act = ports.ownerActive ? await ports.ownerActive(a.project, now) : null;
  const inactive = inactiveReason(act);
  if (inactive || !act) return { id: a.id, result: "wait", reason: inactive ?? "no owner activity evidence" };
  if (pol.mode === "observe") return { id: a.id, result: "observe", evidence: act.evidence };
  try {
    const r = openAskFull(db, reminderDraft(a, now), now, { beforeWrite: () => recheck(db, a, ports, now) });
    if (r.existed) return { id: a.id, result: "skip", reason: "reminder already opened" };
    return { id: a.id, result: "opened", reminder: r.ask, evidence: act.evidence };
  } catch (e) {
    if (e instanceof ReminderAbort) return { id: a.id, result: "skip", reason: e.message };
    if (e instanceof ReminderWait) return { id: a.id, result: "wait", reason: e.message };
    return { id: a.id, result: "wait", reason: `write failed: ${(e as Error).message}` };
  }
}

/**
 * 过期扫描之后调：过期的 reply 类逐条判定（不设回看期限，期限只来自 owner 的 manualAfterMs）。逐条隔离：某条的 port 抛错只让这条 wait，
 * 不连累已开出的。返回每条的结果（observe 日志用）；开出的卡由调用方经 pendingReminderNotices 发 SSE / 通知
 */
export async function sweepReminders(db: Database, ports: ReminderPorts, now = Date.now()): Promise<ReminderOutcome[]> {
  const out: ReminderOutcome[] = [];
  for (const a of listAsks(db, { states: ["expired"], source: "reply" })) {
    if (!KINDS.has(a.kind) || a.blocking !== true || isReminder(a)) continue;
    out.push(await remindOne(db, a, ports, now).catch((e: Error) => ({ id: a.id, result: "wait" as const, reason: `check failed: ${e.message}` })));
  }
  return out;
}

/** 开出了但 SSE / 告诉发起方还没做完的再提示卡（仍 open 的；已答 / 已结的答复或结案通知已经走了，不再补） */
export function pendingReminderNotices(db: Database): Ask[] {
  return listAsks(db, { states: ["open"], source: "reply" }).filter((a) => isReminder(a) && a.extra.remindNotice === "pending");
}

/**
 * 待办通知现在能不能发（SSE / 推送 + 告诉发起方 owner 在线）：策略 on、owner 没暂停、owner 有活跃证据，跟开卡同一道闸；
 * 返回不能发的理由，null = 放行。不抛（port 出错算不放行）。不放行时待办留着，满足了再补——卡本身已在 owner 收件箱里
 */
export async function noticeBlocker(r: Ask, ports: ReminderPorts, now = Date.now()): Promise<string | null> {
  const before = noticeGateNow(r, ports);
  if (before) return before;
  try {
    const why = inactiveReason(ports.ownerActive ? await ports.ownerActive(r.project, now) : null);
    if (why) return why;
  } catch (e) {
    return `check failed: ${(e as Error).message}`;
  }
  // 活跃查询是异步的：等它的时候 owner 可能刚暂停 / 改了模式，回来再看一眼当前的
  return noticeGateNow(r, ports);
}

/**
 * 同步那半道闸：策略此刻是 on、owner 此刻没暂停。不抛（策略读失败已按 off；暂停 port 抛错算不放行）。
 * 调用方在发布前、中间不夹 await 再调一次，保证真正推出去的那一刻仍在当前模式 / 暂停的边界内
 */
export function noticeGateNow(r: Ask, ports: ReminderPorts): string | null {
  const pol = policyOf(ports.policy, r.project);
  if (pol.mode !== "on") return `mode=${pol.mode}`;
  try {
    return ports.paused?.(r) ? "paused by owner" : null;
  } catch (e) {
    return `check failed: ${(e as Error).message}`;
  }
}

/** 通知做完了：记 done，下次不重放（至少一次：记 done 前进程没了会再发一次通知，通知不是执行） */
export function markReminderNoticed(db: Database, id: string, now = Date.now()): void {
  patchAsk(db, id, { extra: { remindNotice: "done" } }, now);
}

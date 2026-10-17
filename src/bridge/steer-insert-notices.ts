/** 插队自己的催答不借频道级看门狗：回给别人不清账，owner 叫停后只告知请求方，不唤醒已停的目标。 */
import { configureSteerInsert, insertSnapshot, sweepInserts, takeInsertReminders } from "./steer-insert.js";
import { newMessageId, newThreadId, type Envelope, type LocalEndpoint } from "./router.js";

interface Deps {
  /** 押后队列落盘；不在线也保留通知，重连后再投。 */
  hold(env: Envelope): void;
  dropRequest(target: string, caller: string, id: string): void;
  stoppedAt(target: string): number | undefined;
  flush?(target: string): Promise<void>;
}
let holdNotice = (_env: Envelope): void => { throw new Error("插队通知尚未接线"); };
const clip = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);
function notification(to: LocalEndpoint, content: string, inReplyTo?: string, reminder = false): Envelope {
  return { from: { kind: "bridge", label: reminder ? "insert-reminder" : "insert-watchdog" }, to, intent: "notification", content,
    meta: { messageId: newMessageId("insert_notice"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(),
      waitForIdle: true, inReplyTo, dropIfStopped: reminder || undefined } };
}
/** 入队后才答复 / 叫停 / 作废 / 过期的提醒不能再投；dropIfStopped 还让它绕开会跳过此检查的通知合批。 */
export function insertNoticeWanted(env: Envelope): boolean {
  if (env.from.kind !== "bridge" || env.from.label !== "insert-reminder") return true;
  return env.to.kind === "local" && !!env.meta.inReplyTo && insertSnapshot(env.to.channelId).has(env.meta.inReplyTo);
}
/** 过期 / 超量 / 叫停：释放该条回程，再把带原文摘要的结局持久化给请求方。 */
export function wireInsertNotices(d: Deps): void {
  holdNotice = (env) => {
    d.hold(env);
    // Stop 原有的补投定时器可能在这封通知入队前已跳过；通知自己排一次，不等下一分钟扫描。
    if (d.flush && env.to.kind === "local") {
      const target = env.to.channelId;
      setTimeout(() => void d.flush!(target).catch((e: Error) => console.error(`⚠️ 插队通知补投失败（留在押后队列）: ${e.message}`)), 2_000).unref?.();
    }
  };
  configureSteerInsert({ stoppedAt: d.stoppedAt, removed: (target, id, e, why) => {
    const t = e.env.to as LocalEndpoint;
    const ending = why === "stopped" ? "目标被 owner 叫停，你的插话可能没被处理，需要的话请重发。"
      : why === "expired" ? "对方 24 小时没明确回复，需要的话请重发。" : "确认账已达上限，无法继续等待明确回复，需要的话请重发。";
    d.dropRequest(target, e.env.from.channelId, id);
    holdNotice(notification(e.env.from, `[ℹ️ bridge] 发给 ${t.agentName || target} 的「${clip(e.env.content)}」：${ending}`, id));
  } });
}
/** snapshot 是 Stop 到达时的 id，drain 等待期间新来的不属于这次 Stop。 */
export function settleInsertStop(target: string, snapshot: ReadonlySet<string>, normal: boolean): void {
  sweepInserts(); // StopFailure / abort 也要处理 owner 叫停后的回显，但不催目标
  if (!normal) return;
  for (const e of takeInsertReminders(target, snapshot)) {
    const caller = e.env.from.agentName || e.env.from.channelId;
    holdNotice(notification(e.env.to as LocalEndpoint,
      `[ℹ️ 插队未回复] ${caller} 的这条还没回：「${clip(e.env.content)}」。请用 send_to_agent 回 ${caller}，或 reply 到它的频道 ${e.env.from.channelId}；已经处理也请明确告诉请求方结果。`,
      e.env.meta.messageId, true));
  }
}

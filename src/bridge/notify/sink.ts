/**
 * 外部通知渠道的出口（docs/design-notify-channels.md）：推送派发器（bridge/push/dispatcher.ts）的第三个出口，和 Web Push / APNs 并列。
 *   · 待你处理：沿用派发器的判定（lib/ask-push.ts）——push 的照推；banner（owner 正在用网页）只推给关了「只在我离开时推」的渠道；
 *     指给 owner 本人的指派事项按 push 算。去重按 ask × 状态记一组渠道（上限按 ask 数算），只记真发出去的渠道：banner 时
 *     被跳过、被频控挡下的渠道，同一条 ask 之后以 push 再来（押后答复撤回、重新打开）还能推。
 *   · 安全 / 系统提醒总是推；Talk @ 受「只在我离开时推」管。带 once 的提醒（额度提醒：Web Push 失败会整条重试，once 是账本里
 *     这批提醒的 id）按渠道记送达，24 h 内重试时已经送到的渠道不再发。去重只在内存：bridge 重启后可能补发一次。
 * 每次发送现读配置文件（低频，改完设置立即生效）；发送本身见 transport.ts。正式通知每个渠道每分钟最多 20 条；测试发送另算
 * （每渠道 20 条、草稿全局 10 条），不占正式额度。发不出去只记结果、打日志，不影响别的渠道和别的出口（tests/notify-sink.test.ts）。
 */
import type { AskPushDecision } from "../../lib/ask-push.js";
import type { Ask } from "../../lib/ledger-asks.js";
import { openLink, redactMessage, type NotifyChannel, type NotifyFile, type NotifyMessage, type NotifyType } from "../../lib/notify-channels.js";
import type { Presence } from "../../lib/owner-presence.js";
import { t } from "../../lib/i18n.js";
import { sendToChannel, type TransportDeps } from "./transport.js";

/** 派发器已经排好版的一条（标题 / 正文已去样式压一行，url 是站内路径） */
export interface SinkMsg {
  title: string;
  body: string;
  url: string;
  tag: string;
}
export interface SendResult {
  at: number;
  type: NotifyType | "test";
  ok: boolean;
  status?: number;
  error?: string;
}
export interface ChannelSink {
  ask(a: Pick<Ask, "id" | "state" | "kind" | "urgency">, decision: AskPushDecision, toOwner: boolean, msg: SinkMsg): void;
  /** once：同一件事的稳定标识（调用方会整条重试的提醒才给），已经送到的渠道 24 h 内不再发 */
  notice(type: NotifyType, msg: SinkMsg, once?: string): void;
}
export interface SinkDeps extends TransportDeps {
  read: () => NotifyFile;
  /** 全局「推送不带正文」：开着时所有渠道一律不带正文 */
  noContent?: () => boolean;
  presence?: () => Presence;
  /** 自动探测的打开地址（中继首页）；配置文件里的 openUrl 优先 */
  linkBase?: () => string | null;
  fp?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

const RECENT_MAX = 20;
const PER_MINUTE = 20;
const TEST_DRAFTS_PER_MINUTE = 10;
const DEDUPE_MAX = 2000;
const ONCE_MS = 24 * 3600_000;
const recent = new Map<string, SendResult[]>();
const sentAt = new Map<string, number[]>();

/** 设置页：每个渠道最近的发送结果（新的在前） */
export function recentResults(): Record<string, SendResult[]> {
  return Object.fromEntries(recent);
}

function record(id: string, r: SendResult): void {
  recent.set(id, [r, ...(recent.get(id) ?? [])].slice(0, RECENT_MAX));
}

function rateLimited(key: string, now: number, max = PER_MINUTE): boolean {
  // 窗口只认 [now-60s, now]：比 now 晚的记录（时钟回拨、测试混用真实时钟和假时钟）不算，否则额度会一直满到时钟追上为止
  const xs = (sentAt.get(key) ?? []).filter((x) => x <= now && now - x < 60_000);
  sentAt.set(key, xs);
  if (xs.length >= max) return true;
  xs.push(now);
  return false;
}

/** 按事件记一组渠道的去重表：上限按事件数算（渠道多了不会提前把还有效的记录挤掉），超出丢最早的事件 */
function markChannel<V>(m: Map<string, Map<string, V>>, event: string, channel: string, v: V): void {
  const per = m.get(event) ?? new Map<string, V>();
  per.set(channel, v);
  m.set(event, per);
  if (m.size > DEDUPE_MAX) m.delete(m.keys().next().value!);
}

/**
 * 渠道设置里的「发测试通知」：测试另有自己的频控（每渠道每分钟 20 条），不占正式通知的额度；带了草稿配置的（draft）
 * 另有全局每分钟 10 条，免得换 id、借已保存 id 绕过
 */
export async function sendTest(c: NotifyChannel, d: SinkDeps, draft = false): Promise<SendResult> {
  const now = (d.now ?? Date.now)();
  if (rateLimited(`test:${c.id}`, now) || (draft && rateLimited("test-drafts", now, TEST_DRAFTS_PER_MINUTE))) {
    const r: SendResult = { at: now, type: "test", ok: false, error: "rate_limited" };
    record(c.id, r);
    return r;
  }
  const base = d.read().openUrl ?? d.linkBase?.() ?? null;
  const m: NotifyMessage = {
    type: "system", title: t("Claudestra · 测试通知", "Claudestra · Test notification"),
    body: t("收到这条，说明这个通知渠道配置正确。", "If you see this, the channel is set up correctly."), url: openLink(base, "/chat", d.fp), tag: `cstra-test-${now}`, ts: now,
  };
  const r: SendResult = { at: now, type: "test", ...(await sendToChannel(c, m, d)) };
  record(c.id, r);
  return r;
}

export function createChannelSink(d: SinkDeps): ChannelSink {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.log(`📣 ${m}`));
  /** 待你处理：「ask:状态」→ 已发出的渠道 */
  const asked = new Map<string, Map<string, true>>();
  /** 带 once 的提醒：once → 渠道 → 送到的时间 */
  const delivered = new Map<string, Map<string, number>>();

  /** 选中的渠道各发一条（异步，不等），返回真发出去的渠道（频控挡下的不算）；onSent 在某个渠道送到后调 */
  function dispatch(type: NotifyType, msg: SinkMsg, pick: (c: NotifyChannel) => boolean, urgent = false, onSent?: (c: NotifyChannel) => void): NotifyChannel[] {
    const file = d.read();
    const targets = file.channels.filter((c) => c.enabled && c.types.includes(type) && pick(c));
    if (!targets.length) return [];
    const ts = now();
    const base = file.openUrl ?? d.linkBase?.() ?? null;
    const full: NotifyMessage = { type, title: msg.title, body: msg.body, url: openLink(base, msg.url, d.fp), tag: msg.tag, ts, urgent };
    const hidden = redactMessage(full, openLink(base, "/chat", d.fp));
    const globalHide = d.noContent?.() === true;
    const sent: NotifyChannel[] = [];
    for (const c of targets) {
      if (rateLimited(c.id, ts)) {
        record(c.id, { at: ts, type, ok: false, error: "rate_limited" });
        continue;
      }
      sent.push(c);
      void sendToChannel(c, c.hideContent || globalHide ? hidden : full, d).then((r) => {
        record(c.id, { at: ts, type, ...r });
        if (r.ok) onSent?.(c);
        else log(`通知渠道「${c.name}」(${c.kind}) 没发出去: ${r.error ?? r.status}`);
      });
    }
    return sent;
  }

  return {
    ask(a, decision, toOwner, msg) {
      const push = decision === "push" || toOwner;
      if (!push && decision !== "banner") return;
      const event = `${a.id}:${a.state}`;
      const sent = dispatch("ask", msg, (c) => (push || !c.onlyWhenAway) && !asked.get(event)?.has(c.id), a.urgency === "urgent");
      for (const c of sent) markChannel(asked, event, c.id, true);
    },
    notice(type, msg, once) {
      const here = d.presence?.() === "active";
      const ts = now();
      const done = (c: NotifyChannel) => !!once && ts - (delivered.get(once)?.get(c.id) ?? -Infinity) < ONCE_MS;
      const markSent = (c: NotifyChannel) => {
        if (once) markChannel(delivered, once, c.id, ts);
      };
      dispatch(type, msg, (c) => !(type === "talk" && c.onlyWhenAway && here) && !done(c), false, markSent);
    },
  };
}

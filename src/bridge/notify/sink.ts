/**
 * 外部通知渠道的出口（docs/design-notify-channels.md）：推送派发器（bridge/push/dispatcher.ts）的第三个出口，和 Web Push / APNs 并列。
 *   · 待你处理：沿用派发器的判定（lib/ask-push.ts）——push 的照推；banner（owner 正在用网页）只推给关了「只在我离开时推」的渠道；
 *     指给 owner 本人的指派事项按 push 算。同一条 ask 每个状态最多推一次。
 *   · 安全 / 系统提醒总是推；Talk @ 受「只在我离开时推」管。
 * 每次发送现读配置文件（低频，改完设置立即生效）；10 s 超时，网络错 / 5xx / 429 隔 2 s 重试一次；每个渠道每分钟最多 20 条。
 * 发不出去只记结果、打日志（不带地址和密钥），不影响别的渠道和别的出口。最近 20 次结果给设置页看（tests/notify-sink.test.ts）。
 */
import type { AskPushDecision } from "../../lib/ask-push.js";
import type { Ask } from "../../lib/ledger-asks.js";
import { buildRequest, openLink, redactMessage, type NotifyChannel, type NotifyFile, type NotifyMessage, type NotifyType } from "../../lib/notify-channels.js";
import type { Presence } from "../../lib/owner-presence.js";
import { t } from "../../lib/i18n.js";

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
  notice(type: NotifyType, msg: SinkMsg): void;
}
export interface SinkDeps {
  read: () => NotifyFile;
  /** 全局「推送不带正文」：开着时所有渠道一律不带正文 */
  noContent?: () => boolean;
  presence?: () => Presence;
  /** 自动探测的打开地址（中继首页）；配置文件里的 openUrl 优先 */
  linkBase?: () => string | null;
  fp?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  retryDelayMs?: number;
}

const TIMEOUT_MS = 10_000;
const RECENT_MAX = 20;
const PER_MINUTE = 20;
const PUSHED_MAX = 2000;
const recent = new Map<string, SendResult[]>();
const sentAt = new Map<string, number[]>();

/** 设置页：每个渠道最近的发送结果（新的在前） */
export function recentResults(): Record<string, SendResult[]> {
  return Object.fromEntries(recent);
}

function record(id: string, r: SendResult): void {
  recent.set(id, [r, ...(recent.get(id) ?? [])].slice(0, RECENT_MAX));
}

function rateLimited(id: string, now: number): boolean {
  const xs = (sentAt.get(id) ?? []).filter((x) => now - x < 60_000);
  sentAt.set(id, xs);
  if (xs.length >= PER_MINUTE) return true;
  xs.push(now);
  return false;
}

const retryable = (status: number | undefined): boolean => status === undefined || status === 429 || status >= 500;

/**
 * 错误信息会进最近结果和日志：请求地址换成主机名（webhook 地址本身就是凭据，飞书 / Slack 的 hook 地址带 token），
 * 渠道的密钥换成尾四位（Bark 的 400 会把 device key 原样写进回包）
 */
function scrub(msg: string, url: string, c: NotifyChannel): string {
  const host = new URL(url).host;
  const secrets = [c.kind === "ntfy" ? c.token : c.kind === "bark" ? c.deviceKey : c.secret].filter((x): x is string => !!x);
  const pairs: [string, string][] = [[url, host], [url.replace(/\/$/, ""), host], ...secrets.map((x): [string, string] => [x, `…${x.slice(-4)}`])];
  return pairs.reduce((m, [a, b]) => m.split(a).join(b), msg).slice(0, 200);
}

/** 非 2xx 的回包里拣一句原因（ntfy 的 error、Bark 的 message）；读不到就空 */
async function reasonOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => ""); // 回包读不完只是少一句原因，状态码照样记
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(j.error ?? j.message ?? "").slice(0, 160);
  } catch {
    return ""; // 不是 JSON（网关的 HTML 错误页之类）：只记状态码，不把整页塞进结果
  }
}

/** 发一条到一个渠道（含一次重试），返回结果；从不抛 */
export async function sendToChannel(c: NotifyChannel, m: NotifyMessage, d: Pick<SinkDeps, "fetch" | "retryDelayMs"> = {}): Promise<Omit<SendResult, "at" | "type">> {
  const f = d.fetch ?? fetch;
  const req = buildRequest(c, m);
  let last: { ok: boolean; status?: number; error?: string } = { ok: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, d.retryDelayMs ?? 2000));
    try {
      const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        await res.body?.cancel().catch(() => {}); // 成功的回包内容不需要；cancel 失败只是连接晚点回收
        last = { ok: true, status: res.status };
      } else {
        const why = await reasonOf(res);
        last = { ok: false, status: res.status, error: scrub(`HTTP ${res.status}${why ? ` · ${why}` : ""}`, req.url, c) };
      }
    } catch (e) {
      last = { ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : scrub((e as Error).message, req.url, c) };
    }
    if (last.ok || !retryable(last.status)) break;
  }
  return last;
}

/** 渠道设置里的「发测试通知」 */
export async function sendTest(c: NotifyChannel, d: SinkDeps): Promise<SendResult> {
  const now = (d.now ?? Date.now)();
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
  const pushed = new Set<string>();

  function dispatch(type: NotifyType, msg: SinkMsg, pick: (c: NotifyChannel) => boolean, urgent = false): void {
    const file = d.read();
    const targets = file.channels.filter((c) => c.enabled && c.types.includes(type) && pick(c));
    if (!targets.length) return;
    const ts = now();
    const base = file.openUrl ?? d.linkBase?.() ?? null;
    const full: NotifyMessage = { type, title: msg.title, body: msg.body, url: openLink(base, msg.url, d.fp), tag: msg.tag, ts, urgent };
    const hidden = redactMessage(full, openLink(base, "/chat", d.fp));
    const globalHide = d.noContent?.() === true;
    for (const c of targets) {
      if (rateLimited(c.id, ts)) {
        record(c.id, { at: ts, type, ok: false, error: "rate_limited" });
        continue;
      }
      void sendToChannel(c, c.hideContent || globalHide ? hidden : full, d).then((r) => {
        record(c.id, { at: ts, type, ...r });
        if (!r.ok) log(`通知渠道「${c.name}」(${c.kind}) 没发出去: ${r.error ?? r.status}`);
      });
    }
  }

  return {
    ask(a, decision, toOwner, msg) {
      const key = `${a.id}:${a.state}`;
      if (pushed.has(key)) return;
      const push = decision === "push" || toOwner;
      if (!push && decision !== "banner") return;
      pushed.add(key);
      if (pushed.size > PUSHED_MAX) pushed.delete(pushed.values().next().value!);
      dispatch("ask", msg, (c) => push || !c.onlyWhenAway, a.urgency === "urgent");
    },
    notice(type, msg) {
      const here = d.presence?.() === "active";
      dispatch(type, msg, (c) => !(type === "talk" && c.onlyWhenAway && here));
    },
  };
}

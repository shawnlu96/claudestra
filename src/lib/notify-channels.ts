/**
 * 外部通知渠道（docs/design-notify-channels.md）：ntfy / Bark / Webhook 的配置校验、对外视图（密钥只露尾四位）、
 * 以及把一条通知翻成各家的 HTTP 请求。纯函数，发送与落盘在 bridge/notify/、lib/notify-store.ts（tests/notify-channels.test.ts）。
 */
import { createHmac, randomBytes } from "node:crypto";
import { t } from "./i18n.js";

type NotifyKind = "ntfy" | "bark" | "webhook";
/** 待你处理 / 安全提醒（新设备配对）/ 系统提醒（额度、状态文件）/ Talk 里 @ 你 */
export type NotifyType = "ask" | "security" | "system" | "talk";
const NOTIFY_TYPES: readonly NotifyType[] = ["ask", "security", "system", "talk"];
const NOTIFY_KINDS: readonly NotifyKind[] = ["ntfy", "bark", "webhook"];
const DEFAULT_TYPES: NotifyType[] = ["ask", "security", "system"];
const MAX_CHANNELS = 10;

interface ChannelBase {
  id: string;
  kind: NotifyKind;
  name: string;
  enabled: boolean;
  types: NotifyType[];
  /** 待你处理、Talk @：owner 正在用网页时不推（安全 / 系统提醒不受影响） */
  onlyWhenAway: boolean;
  /** 全部待你处理都推：不看卡片标没标卡活（验收类仍不推）。关 = 只推标了卡活的，和 Web Push / APNs 的加推规则一样 */
  allAsks: boolean;
  /** 只推「Claudestra · 类型」，不带谁发的、标题、正文 */
  hideContent: boolean;
}
interface NtfyChannel extends ChannelBase {
  kind: "ntfy";
  server: string;
  topic: string;
  token?: string;
}
interface BarkChannel extends ChannelBase {
  kind: "bark";
  server: string;
  deviceKey: string;
}
interface WebhookChannel extends ChannelBase {
  kind: "webhook";
  url: string;
  secret?: string;
}
export type NotifyChannel = NtfyChannel | BarkChannel | WebhookChannel;

export interface NotifyFile {
  channels: NotifyChannel[];
  /** 点通知打开的地址（如 Tailscale 的 https 入口）；不填 = 有中继用中继首页，没有就不带链接 */
  openUrl?: string;
}

/** 密钥字段：只进 bridge，对外视图换成尾四位提示 */
const SECRET_FIELDS = { ntfy: ["token"], bark: ["deviceKey"], webhook: ["url", "secret"] } as const;
const DEFAULT_SERVER: Record<"ntfy" | "bark", string> = { ntfy: "https://ntfy.sh", bark: "https://api.day.app" };

const ID_RE = /^[a-z0-9]{8,24}$/;
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const BARK_KEY_RE = /^[A-Za-z0-9]{8,64}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,200}$/;
const NAME_MAX = 40;

const newChannelId = (): string => randomBytes(6).toString("hex");

/** http(s) 地址，去掉末尾斜线；不合法 → null */
function httpUrl(v: unknown, max = 2000): string | null {
  if (typeof v !== "string" || !v.trim() || v.length > max) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null; // 凭据写进地址会进日志、进对外视图：用 token 字段
    return u.href.replace(/\/+$/, "");
  } catch {
    return null; // 解析不了 = 不是地址，调用方按「不合法」报 400
  }
}

const hint = (v: string | undefined): string => (v ? `…${v.slice(-4)}` : "");

/** 配置文件里的 openUrl：不是 http(s) 地址就当没填（手改坏了不能让拼链接时抛错） */
export const cleanOpenUrl = (v: unknown): string | undefined => httpUrl(v) ?? undefined;

/**
 * 校验一条渠道。密钥字段缺省 = 沿用 prev 里同 id 的旧值（网页只拿到尾四位，没改就不回传）；空串 = 清除（必填的清了报错）。
 * 返回渠道或错误说明（英文，给 API 400）。
 */
export function normalizeChannel(raw: unknown, prev?: NotifyChannel): NotifyChannel | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (!NOTIFY_KINDS.includes(kind as NotifyKind)) return `kind must be one of ${NOTIFY_KINDS.join(", ")}`;
  if (prev && prev.kind !== kind) prev = undefined;
  const id = r.id === undefined ? newChannelId() : r.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return "id must be 8-24 lowercase letters or digits";
  const types = r.types === undefined ? (prev?.types ?? DEFAULT_TYPES) : r.types;
  if (!Array.isArray(types) || !types.every((x) => NOTIFY_TYPES.includes(x as NotifyType))) return `types must be a subset of ${NOTIFY_TYPES.join(", ")}`;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, NAME_MAX) : (prev?.name ?? String(kind));
  const flag = (k: "enabled" | "onlyWhenAway" | "allAsks" | "hideContent", dflt: boolean) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (prev?.[k] ?? dflt));
  // allAsks 缺省开：外部渠道收不到回复推送，只推卡活的会漏掉回复里带按钮自动建的卡片（没有这个字段的旧配置读出来也按开算）。
  // onlyWhenAway 缺省关：网页常驻在屏幕上时 owner 一直算「在」（lib/owner-presence.ts 只看页面可见），缺省开的话新渠道什么都收不到
  const base = {
    id, name, enabled: flag("enabled", true), types: [...new Set(types as NotifyType[])],
    onlyWhenAway: flag("onlyWhenAway", false), allAsks: flag("allAsks", true), hideContent: flag("hideContent", false),
  };
  const secret = (k: string): string | undefined => {
    const v = r[k];
    if (v === undefined) return (prev as unknown as Record<string, string | undefined> | undefined)?.[k];
    return typeof v === "string" ? v.trim() || undefined : undefined;
  };
  if (kind === "ntfy") {
    const server = r.server === undefined || r.server === "" ? (prev as NtfyChannel | undefined)?.server ?? DEFAULT_SERVER.ntfy : httpUrl(r.server);
    if (!server) return "server must be an http(s) URL";
    const topic = typeof r.topic === "string" ? r.topic.trim() : (prev as NtfyChannel | undefined)?.topic;
    if (!topic || !TOPIC_RE.test(topic)) return "topic must be 1-64 letters, digits, - or _";
    const token = secret("token");
    if (token && !TOKEN_RE.test(token)) return "token has invalid characters";
    return { ...base, kind, server, topic, ...(token ? { token } : {}) };
  }
  if (kind === "bark") {
    const server = r.server === undefined || r.server === "" ? (prev as BarkChannel | undefined)?.server ?? DEFAULT_SERVER.bark : httpUrl(r.server);
    if (!server) return "server must be an http(s) URL";
    const deviceKey = secret("deviceKey");
    if (!deviceKey || !BARK_KEY_RE.test(deviceKey)) return "deviceKey must be 8-64 letters or digits";
    return { ...base, kind, server, deviceKey };
  }
  const url = r.url === undefined ? (prev as WebhookChannel | undefined)?.url : httpUrl(r.url);
  if (!url) return "url must be an http(s) URL";
  const s = secret("secret");
  if (s && !TOKEN_RE.test(s)) return "secret has invalid characters";
  return { ...base, kind: "webhook", url, ...(s ? { secret: s } : {}) };
}

/** 整份配置（PUT 体）：按 id 对上旧渠道沿用密钥；最多 MAX_CHANNELS 个、id 不重复 */
export function normalizeFile(raw: unknown, prev: NotifyFile): NotifyFile | string {
  const r = (raw ?? {}) as { channels?: unknown; openUrl?: unknown };
  if (!Array.isArray(r.channels)) return "channels must be an array";
  if (r.channels.length > MAX_CHANNELS) return `at most ${MAX_CHANNELS} channels`;
  const byId = new Map(prev.channels.map((c) => [c.id, c]));
  const out: NotifyChannel[] = [];
  for (const raw1 of r.channels) {
    const id = (raw1 as { id?: unknown })?.id;
    const c = normalizeChannel(raw1, typeof id === "string" ? byId.get(id) : undefined);
    if (typeof c === "string") return c;
    if (out.some((x) => x.id === c.id)) return `duplicate channel id ${c.id}`;
    out.push(c);
  }
  let openUrl = prev.openUrl;
  if (r.openUrl !== undefined) {
    if (r.openUrl === "") openUrl = undefined;
    else if (!(openUrl = cleanOpenUrl(r.openUrl))) return "openUrl must be an http(s) URL";
  }
  return { channels: out, ...(openUrl ? { openUrl } : {}) };
}

/** 对外视图：密钥字段换成 <字段>Hint（尾四位）+ <字段>Set；webhook 地址只露主机名 */
export function channelView(c: NotifyChannel): Record<string, unknown> {
  const v: Record<string, unknown> = { ...c };
  for (const k of SECRET_FIELDS[c.kind]) {
    const val = (c as unknown as Record<string, string | undefined>)[k];
    delete v[k];
    v[`${k}Set`] = !!val;
    v[`${k}Hint`] = k === "url" && val ? `${new URL(val).host}/${hint(val)}` : hint(val);
  }
  return v;
}

export interface NotifyMessage {
  type: NotifyType;
  title: string;
  body: string;
  /** 点开打开的绝对地址；没有可达入口就不带 */
  url?: string;
  /** 同一件事的标识（Bark 同 id 替换）；只含 ask id / 时间，不含正文 */
  tag: string;
  ts: number;
  /** 急件：渠道用最高级别提醒 */
  urgent?: boolean;
}

const TYPE_LABEL: Record<NotifyType, () => string> = {
  ask: () => t("待你处理", "Needs you"),
  security: () => t("安全提醒", "Security"),
  system: () => t("系统提醒", "System"),
  talk: () => t("Talk 里有人 @ 你", "Mentioned in Talk"),
};
const typeLabel = (type: NotifyType): string => TYPE_LABEL[type]();

/** 不带正文：只剩「Claudestra · 类型」和打开首页的链接（谁发的、标题、ask id 都不出本机） */
export function redactMessage(m: NotifyMessage, home?: string): NotifyMessage {
  return { type: m.type, title: `Claudestra · ${typeLabel(m.type)}`, body: t("打开 Claudestra 查看", "Open Claudestra to view"), url: home, tag: `cstra-${m.ts}`, ts: m.ts, urgent: m.urgent };
}

export interface HttpRequestSpec {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** ntfy 优先级 1-5：急件 5，待你处理 / 安全 4，其余默认 3 */
const ntfyPriority = (m: NotifyMessage): number => (m.urgent ? 5 : m.type === "ask" || m.type === "security" ? 4 : 3);
const NTFY_TAGS: Record<NotifyType, string> = { ask: "bell", security: "warning", system: "gear", talk: "speech_balloon" };

/** 一条通知 → 这个渠道的 HTTP 请求。ntfy 用 JSON 发布（POST 到服务器根）：标题走 HTTP 头放不了中文 */
export function buildRequest(c: NotifyChannel, m: NotifyMessage): HttpRequestSpec {
  const json = { "content-type": "application/json" };
  if (c.kind === "ntfy") {
    const body = { topic: c.topic, title: m.title, message: m.body, priority: ntfyPriority(m), tags: [NTFY_TAGS[m.type]], ...(m.url ? { click: m.url } : {}) };
    return { url: `${c.server}/`, method: "POST", headers: { ...json, ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) }, body: JSON.stringify(body) };
  }
  if (c.kind === "bark") {
    // timeSensitive：专注模式下也能弹出；critical 要用户另给权限，不默认用
    const level = m.urgent || m.type === "ask" || m.type === "security" ? "timeSensitive" : "active";
    const body = { device_key: c.deviceKey, title: m.title, body: m.body, group: "Claudestra", level, id: m.tag.slice(0, 64), ...(m.url ? { url: m.url } : {}) };
    return { url: `${c.server}/push`, method: "POST", headers: json, body: JSON.stringify(body) };
  }
  const body = JSON.stringify({ source: "claudestra", type: m.type, title: m.title, body: m.body, url: m.url ?? null, tag: m.tag, ts: m.ts, urgent: !!m.urgent });
  const ts = String(Math.floor(m.ts / 1000));
  const sig: Record<string, string> = c.secret ? { "x-claudestra-signature": `sha256=${webhookSignature(c.secret, ts, body)}` } : {};
  return { url: c.url, method: "POST", headers: { ...json, "x-claudestra-event": m.type, "x-claudestra-timestamp": ts, ...sig }, body };
}

/** Webhook 签名：HMAC-SHA256(secret, "<秒级时间戳>.<原始请求体>") 的 hex；接收方用同样方式算、比对，并拒绝过旧的时间戳 */
export function webhookSignature(secret: string, ts: string, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

/** 点开的地址：基址 + 站内路径，带本机指纹让网页先切到这台机器（web/features/machines/machine-gate.tsx 认 ?fp=） */
export function openLink(base: string | null | undefined, path: string, fp?: string): string | undefined {
  if (!base) return undefined;
  const u = new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`); // 相对拼：基址带路径（反代子路径）时不丢
  if (fp) u.searchParams.set("fp", fp);
  return u.href;
}

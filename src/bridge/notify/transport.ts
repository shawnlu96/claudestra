/**
 * 外部通知渠道的 HTTP 发送（sink.ts 调）：一条通知发到一个渠道，含一次重试，从不抛。三道出站防线（tests/notify-transport.test.ts）：
 *   · 不跟随重定向：3xx 一律算失败。跟随的话，通知服务器回一个 307 就能把 bridge 的 POST 引到任何地方；
 *   · 目的地址解析到本机（127.0.0.0/8、::1、0.0.0.0、::）就不发：bridge 的控制面（/relay/pair/*、/relay/request）对回环来源免鉴权，
 *     通知请求打到本机 = 借 bridge 自己的身份调控制面。局域网地址照发——从局域网来的请求本来就要控制令牌（BRIDGE_CONTROL_TOKEN）；
 *     解析与连接之间换 IP（DNS rebinding）这里拦不住，记在 docs/design-notify-channels.md 的已知局限里；
 *   · 出错回包最多读 4 KB，拷进固定大小的缓冲区：拣一句原因用，整包（或整块）读进内存会被恶意服务器拿超大回包撑爆。
 * 解析也算在每次尝试里：DNS 最多等 5 s（迟到的结果直接丢），临时失败和网络错一样重试一次；拒发本机地址不重试。
 * 错误信息进最近结果与日志前先脱敏（地址 → 主机名、渠道密钥 → 尾四位）再截断：先截断会把跨在截断处的密钥留下前半截。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { buildRequest, type NotifyChannel, type NotifyMessage } from "../../lib/notify-channels.js";

const TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;
const ERROR_BODY_MAX = 4096;
const ERROR_TEXT_MAX = 200;

export type Lookup = (host: string) => Promise<string[]>;
const realLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface TransportDeps {
  fetch?: typeof fetch;
  lookup?: Lookup;
  retryDelayMs?: number;
  /** 单测缩短解析超时；生产用 DNS_TIMEOUT_MS */
  dnsTimeoutMs?: number;
}
export interface SendOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * 连到它等于连本机：127.0.0.0/8、::1，以及系统会当成本机的 0.0.0.0 / ::；IPv4 映射的 IPv6 按里面的 IPv4 判——
 * URL 解析会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]，两种写法都认
 */
export function isLoopbackAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v.startsWith("::ffff:") && isIP(v.slice(7)) === 4) return isLoopbackAddress(v.slice(7));
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isLoopbackAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (v === "::1" || v === "::" || v === "0:0:0:0:0:0:0:1") return true;
  return isIP(v) === 4 && (v.startsWith("127.") || v === "0.0.0.0");
}

/** 目的地址能不能发：null = 能；retry = 解析超时 / 临时失败，可以再试；拒发本机地址不再试 */
async function destinationProblem(url: string, lookup: Lookup, timeoutMs: number): Promise<{ error: string; retry: boolean } | null> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    if (isIP(host)) addrs = [host];
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(Object.assign(new Error("dns timeout"), { code: "timeout" })), timeoutMs)));
      addrs = await Promise.race([lookup(host), late]).finally(() => clearTimeout(timer));
    }
  } catch (e) {
    return { error: `dns: ${(e as { code?: string }).code ?? "lookup failed"}`, retry: true };
  }
  return addrs.some(isLoopbackAddress) ? { error: "refused: destination is this machine", retry: false } : null;
}

/** 出错回包最多读 ERROR_BODY_MAX 字节（解压后），每块只拷剩下的额度进固定缓冲区，读够就断开 */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const buf = new Uint8Array(ERROR_BODY_MAX);
  let n = 0;
  try {
    while (n < ERROR_BODY_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, ERROR_BODY_MAX - n);
      buf.set(value.subarray(0, take), n);
      n += take;
    }
  } catch {
    // 读到一半断了：已读到的部分照样拣原因，状态码照记
  } finally {
    await reader.cancel().catch(() => {}); // 剩下的不要了；cancel 失败只是连接晚点回收
  }
  return new TextDecoder().decode(buf.subarray(0, n));
}

/** 非 2xx 回包里的一句原因（ntfy 的 error、Bark 的 message）；不是 JSON 就空（网关 HTML 错误页之类不往结果里塞） */
function reasonOf(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(j.error ?? j.message ?? "");
  } catch {
    return ""; // 不是 JSON：只记状态码
  }
}

/** 地址 → 主机名、渠道密钥 → 尾四位，然后才截断 */
function scrub(msg: string, url: string, c: NotifyChannel): string {
  const host = new URL(url).host;
  const secrets = [c.kind === "ntfy" ? c.token : c.kind === "bark" ? c.deviceKey : c.secret].filter((x): x is string => !!x);
  const pairs: [string, string][] = [[url, host], [url.replace(/\/$/, ""), host], ...secrets.map((x): [string, string] => [x, `…${x.slice(-4)}`])];
  return pairs.reduce((m, [a, b]) => m.split(a).join(b), msg).slice(0, ERROR_TEXT_MAX);
}

const retryable = (o: SendOutcome): boolean => !o.ok && (o.status === undefined || o.status === 429 || o.status >= 500);

/** 一次尝试：先查目的地址再发；retry = 这个结果值得隔一会儿再试一次 */
async function attempt(c: NotifyChannel, req: ReturnType<typeof buildRequest>, d: TransportDeps): Promise<{ out: SendOutcome; retry: boolean }> {
  const bad = await destinationProblem(req.url, d.lookup ?? realLookup, d.dnsTimeoutMs ?? DNS_TIMEOUT_MS);
  if (bad) return { out: { ok: false, error: bad.error }, retry: bad.retry };
  const out = await post(c, req, d.fetch ?? fetch);
  return { out, retry: retryable(out) };
}

async function post(c: NotifyChannel, req: ReturnType<typeof buildRequest>, f: typeof fetch): Promise<SendOutcome> {
  try {
    const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {}); // 不跟随，回包不要；cancel 失败只是连接晚点回收
      return { ok: false, status: res.status, error: `HTTP ${res.status} · redirect not followed` };
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {}); // 成功的回包内容不需要
      return { ok: true, status: res.status };
    }
    const why = reasonOf(await readCapped(res));
    return { ok: false, status: res.status, error: scrub(`HTTP ${res.status}${why ? ` · ${why}` : ""}`, req.url, c) };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : scrub((e as Error).message, req.url, c) };
  }
}

/** 发一条到一个渠道（DNS 临时失败 / 网络错 / 5xx / 429 隔一会儿重试一次）；从不抛。最长约 2 ×（5 s 解析 + 10 s 请求）+ 重试间隔 */
export async function sendToChannel(c: NotifyChannel, m: NotifyMessage, d: TransportDeps = {}): Promise<SendOutcome> {
  const req = buildRequest(c, m);
  let last: SendOutcome = { ok: false };
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, d.retryDelayMs ?? 2000));
    const r = await attempt(c, req, d);
    last = r.out;
    if (!r.retry) break;
  }
  return last;
}

/**
 * 推送 endpoint 的 SSRF 规则（docs/design-hosted-frontend.md §6）：它是浏览器提交、由服务端主动去 POST 的外部 URL，
 * 所以只许 https，且主机名不能是回环 / 私网 / 链路本地 / 未指定地址的 IP 字面量，也不能是 localhost。
 * 中继（src/relay/push.ts）与 bridge 直发（bridge/push/routes.ts 收订阅时）共用一份。只看字面量：域名解析到私网
 * 这一层不在这里管（推送服务都是知名域名，DNS 重绑定的防线是「只接受 https + 限响应 + 超时」）。
 * WHATWG URL 解析已把 `0x7f.1`、十进制整数这类写法规整成点分 IPv4，所以拿 hostname 比对就够。
 */

export interface EndpointRules {
  /** 测试专用：允许回环 / 私网地址（本地假推送服务），https 仍然必须 */
  allowPrivate?: boolean;
}

function parseV4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv4 里不该出现在公网推送服务上的段：未指定、私网、CGNAT、回环、链路本地、协议保留、基准测试、组播、保留 / 广播 */
const V4_BLOCKED: Array<[number, number]> = (
  [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as Array<[string, number]>
).map(([prefix, bits]) => [parseV4(prefix)!, bits]);

function v4Blocked(addr: number): boolean {
  return V4_BLOCKED.some(([prefix, bits]) => bits === 0 || (addr >>> (32 - bits)) === (prefix >>> (32 - bits)));
}

/** `[::1]` / `::ffff:10.0.0.1` 之类 → 8 个 16 位组；解析不了返回 null（当作非法主机） */
function parseV6(raw: string): number[] | null {
  let s = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4Tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4Tail) {
    const v4 = parseV4(v4Tail[1]);
    if (v4 === null) return null;
    s = `${s.slice(0, -v4Tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function v6Blocked(g: number[]): boolean {
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) return v4Blocked(((g[6] << 16) | g[7]) >>> 0);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(((g[6] << 16) | g[7]) >>> 0); // 64:ff9b::/96 NAT64
  return false;
}

/**
 * 不能推的原因（短词，只进日志）；null = 可以。调用方对外一律说 endpoint_forbidden，不区分原因——
 * 区分了也帮不到正常用户，只帮到探测内网的人。
 */
export function pushEndpointProblem(endpoint: string, rules: EndpointRules = {}): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "unparsable"; // 不是 URL 就谈不上私网不私网，直接拒
  }
  if (u.protocol !== "https:") return "scheme";
  if (u.username || u.password) return "credentials";
  const host = u.hostname.toLowerCase();
  if (!host) return "empty_host";
  if (rules.allowPrivate) return null;
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  const v4 = parseV4(host);
  if (v4 !== null) return v4Blocked(v4) ? "private_v4" : null;
  if (host.startsWith("[")) {
    const v6 = parseV6(host);
    return !v6 || v6Blocked(v6) ? "private_v6" : null;
  }
  return null;
}

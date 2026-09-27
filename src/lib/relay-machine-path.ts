/**
 * 中继「按路径找机器」模式（docs/design-hosted-frontend.md §4、§6）：`https://<base>/m/<fp>/api/v1/…` 转给指纹 fp 那台
 * 实例，路径去掉 `/m/<fp>` 前缀。中继与实例都 import 这里的常量与纯函数（tests/relay-machine-path.test.ts）：
 *   - 路径规范化只放 /api/v1 下的请求：拒 `..`、连续 `/`、控制字符、编码过的 `/` `%` `.`——中继不是任意转发器；
 *   - 机器响应头过滤：只放一个名字的 Set-Cookie 且属性钉死（Path 就是这台机器的前缀），别的 Set-Cookie 与能影响
 *     整个主源的头一律丢——同一主源上所有用户的机器共存，一台机器不能碰到别台的 cookie / SW / 站点数据。
 */
import { FP_RE, type Headers } from "./relay-protocol.js";
import { SET_COOKIE_SEP } from "./relay-stream.js";
import { DEVICE_COOKIE } from "./devices.js";

export const MACHINE_PREFIX = "/m/";
/** 请求头："api" = 路径模式，实例在进程内 dispatch；没有这个头 = 旧的子域名隧道，实例原样打本机 Web */
export const RELAY_MODE_HEADER = "x-claudestra-relay-mode";
export const RELAY_MODE_API = "api";
/** 请求头：这台机器在中继上的路径前缀 `/m/<fp>`（实例拼绝对地址、设 cookie Path 时用） */
export const RELAY_PREFIX_HEADER = "x-claudestra-relay-prefix";

export interface MachinePath {
  fp: string;
  /** 去掉前缀后的路径（不含查询串），已确认在 /api/v1 下 */
  rest: string;
  /** `/m/<fp>` */
  prefix: string;
}
export type MachinePathError = "not_machine_path" | "bad_fingerprint" | "path_forbidden";

const CTRL_RE = /[\x00-\x1f\x7f]/;
/** 编码形式的 / \ % . 一律拒：解码前后含义不同的路径没有正当用途 */
const ENCODED_SPECIAL_RE = /%(2f|5c|25|2e)/i;

/** 解码一次后必须落在 /api/v1 下，且没有 . / .. 段、连续斜线、反斜线、控制字符 */
export function apiPathAllowed(rest: string): boolean {
  if (ENCODED_SPECIAL_RE.test(rest)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return false; // 非法百分号编码：不是能路由的路径
  }
  if (CTRL_RE.test(decoded) || decoded.includes("//") || decoded.includes("\\")) return false;
  if (decoded.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return decoded === "/api/v1" || decoded.startsWith("/api/v1/");
}

export function parseMachinePath(pathname: string): MachinePath | MachinePathError {
  if (!pathname.startsWith(MACHINE_PREFIX)) return "not_machine_path";
  const after = pathname.slice(MACHINE_PREFIX.length);
  const slash = after.indexOf("/");
  const fp = (slash < 0 ? after : after.slice(0, slash)).toLowerCase();
  if (!FP_RE.test(fp)) return "bad_fingerprint";
  const rest = slash < 0 ? "/" : after.slice(slash);
  return apiPathAllowed(rest) ? { fp, rest, prefix: `${MACHINE_PREFIX}${fp}` } : "path_forbidden";
}

/** 浏览器发来的头里，Cookie 只把设备凭据那一对带给机器：主源上别的 cookie 与这台机器无关 */
export function filterMachineRequestHeaders(h: Headers, cookieName = DEVICE_COOKIE): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== "cookie") {
      out[k] = v;
      continue;
    }
    const pair = v.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${cookieName}=`));
    if (pair) out[k] = pair;
  }
  return out;
}

const DROP_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["clear-site-data", "service-worker-allowed", "set-cookie2", "alt-svc"]);
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{0,512}$/;
const KEEP_COOKIE_ATTR_RE = /^(max-age|expires)=/i;

/** 只放设备 cookie，且不管机器怎么写，属性一律改成这一组；值为空 = 删除 cookie，照放 */
export function pinDeviceCookie(cookie: string, prefix: string, cookieName = DEVICE_COOKIE): string | null {
  const [nameValue = "", ...attrs] = cookie.split(";").map((s) => s.trim());
  const eq = nameValue.indexOf("=");
  if (eq <= 0 || nameValue.slice(0, eq).trim() !== cookieName) return null;
  const value = nameValue.slice(eq + 1).trim();
  if (!COOKIE_VALUE_RE.test(value)) return null;
  const keep = attrs.filter((a) => KEEP_COOKIE_ATTR_RE.test(a));
  return [`${cookieName}=${value}`, `Path=${prefix}/`, ...keep, "HttpOnly", "Secure", "SameSite=Strict"].join("; ");
}

/** 机器给的根相对跳转补上前缀；绝对地址与协议相对地址（//）不动 */
export function prefixLocation(location: string, prefix: string): string {
  return location.startsWith("/") && !location.startsWith("//") ? `${prefix}${location}` : location;
}

/** 机器响应头 → 可以交给浏览器的头（Set-Cookie 多值以 SET_COOKIE_SEP 连接，见 relay-stream.ts） */
export function filterMachineResponseHeaders(h: Headers, prefix: string, cookieName = DEVICE_COOKIE): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(key)) continue;
    if (key === "set-cookie") {
      const kept = v.split(SET_COOKIE_SEP).map((c) => pinDeviceCookie(c, prefix, cookieName)).filter((c): c is string => c !== null);
      if (kept.length) out[key] = kept.join(SET_COOKIE_SEP);
    } else if (key === "location") out[key] = prefixLocation(v, prefix);
    else out[key] = v;
  }
  return out;
}

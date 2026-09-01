/**
 * v2.10+ Web 前端网关件 —— docs/web-frontend-guide.md §7 三堵墙中的两堵：
 * CORS 与静态托管。纯函数（可单测），接线在 bridge.ts 的 Bun.serve fetch：
 * OPTIONS preflight 短路 → 正常路由 → 响应统一补 CORS 头 → 未匹配 GET 落静态。
 *
 * 两者都默认关闭（环境变量不设 = 行为与 v2.9 完全一致）：
 *   BRIDGE_CORS_ORIGIN  逗号分隔 origin 白名单，或 "*"
 *   BRIDGE_STATIC_DIR   要托管的静态目录（SPA 前端构建产物）
 */

import { existsSync, statSync } from "fs";
import { join, normalize, resolve } from "path";

/**
 * 按白名单算这次请求该发的 CORS 头。返回 null = 不发（未开启 / origin 不在名单）。
 * 白名单精确匹配 origin 字符串（如 "http://localhost:5173"）；"*" 允许任意。
 */
export function corsHeadersFor(
  reqOrigin: string | null,
  allowSetting: string,
): Record<string, string> | null {
  const allowed = (allowSetting || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return null;
  let origin: string | null = null;
  if (allowed.includes("*")) origin = "*";
  else if (reqOrigin && allowed.includes(reqOrigin)) origin = reqOrigin;
  if (!origin) return null;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*") headers["Vary"] = "Origin";
  return headers;
}

/**
 * v2.13.1+ 这次请求是否来自"另一个源的浏览器页面"。
 *
 * WebSocket 不受同源策略约束：任何网页都能 new WebSocket("ws://127.0.0.1:3847")，
 * 而 bridge 的 ws 控制面上挂着 route_to_agent —— 往跑 bypassPermissions 的 agent
 * 注入任意文本，等价于主机 RCE。绑回环地址挡不住这条路（2026-07-25 实测：伪造
 * Origin 的连接被正常接受并拿到全部频道列表）。HTTP 侧同理，/agent/cleanup 之类
 * 的副作用端点没有 CSRF token，简单 POST 不触发 preflight 就能打进来。
 *
 * 判据：
 * - 无 Origin 头 → 不是浏览器发起（channel-server / manager / curl / 服务端 fetch）
 * - Origin 与本次请求同源 → 自家页面（BRIDGE_STATIC_DIR 托管的前端；注意同源
 *   fetch 也会带 Origin，不能一见 Origin 就拒）
 * - 其余 → 跨源
 */
export function isCrossOrigin(reqOrigin: string | null, requestUrl: string): boolean {
  if (!reqOrigin) return false;
  try {
    return reqOrigin !== new URL(requestUrl).origin;
  } catch {
    return true; // URL 解析不了就按最坏情况算
  }
}

/**
 * 该跨源 origin 是否被**逐条显式**放行。
 *
 * 刻意不认 "*"：BRIDGE_CORS_ORIGIN="*" 对读数据的 HTTP 端点是用户的自主选择，
 * 但把 ws 控制面向任意网页敞开等于交出这台机器，不该被一个通配符顺带打开。
 * 真要让浏览器直连 ws，就把具体 origin 写进白名单。
 */
export function isOriginExplicitlyAllowed(
  reqOrigin: string | null,
  allowSetting: string,
): boolean {
  if (!reqOrigin) return false;
  return (allowSetting || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(reqOrigin);
}

/**
 * v2.21.1+ 控制面非回环访问闸(security-audit 2026-09-01 巡检 P0)。
 *
 * bridge 的裸控制路由(/hook /stats /stats/refresh /skills/rescan /agent/cleanup
 * /events)和 ws 升级(route_to_agent = 主机 RCE)一直无鉴权。BRIDGE_BIND=0.0.0.0
 * 时它们暴露给整个 LAN + tailnet。回环客户端(channel-server/manager/web-BFF/
 * discord-reply)是全部合法流量;唯一合法的非回环入站是 HTTP peer,而 peer 走
 * /api/v1(自带 Bearer)。
 *
 * 判据(纯函数,单测):
 *   - 回环(127/8、::1、::ffff:127.*)→ 放行,豁免一切(信任本机)
 *   - 非回环 + /api/v1/* → 放行,交给 handleApiRequest 自己的 Bearer 鉴权(peer)
 *   - 非回环 + 其余 → 要求 control token 命中,否则拒
 *
 * fail-closed:BRIDGE_CONTROL_TOKEN 未设时,非回环非-/api/v1 一律拒(当前无此类
 * 合法流量,零影响;要开放远程直连裸路由再设 token)。requestIP 取不到地址(null)
 * 按非回环处理——实测本机回环的 http/ws-upgrade 都稳定返回 127.0.0.1,不会误伤。
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

export function controlAccessVerdict(opts: {
  loopback: boolean;
  pathname: string;
  providedToken: string | null;
  controlToken: string;
}): { allow: boolean; reason: string } {
  if (opts.loopback) return { allow: true, reason: "loopback" };
  // /api/v1/* 有自己的 Bearer 鉴权(peer 入站走这里),放行给它自处理
  if (opts.pathname.startsWith("/api/v1/")) return { allow: true, reason: "api-bearer" };
  // 其余控制路由 + ws 升级:非回环必须命中 control token
  if (opts.controlToken && opts.providedToken === opts.controlToken) {
    return { allow: true, reason: "control-token" };
  }
  return { allow: false, reason: opts.controlToken ? "bad-token" : "no-token-configured" };
}

/**
 * 静态文件路径解析：穿越防护 + SPA fallback。
 * - 命中真实文件 → 绝对路径
 * - 路径不存在且不像资源文件（最后一段无扩展名）→ index.html（前端路由 fallback）
 * - 穿越出 root / 资源文件缺失 / root 未设 → null（调用方 404）
 */
export function resolveStaticPath(rootDir: string, pathname: string): string | null {
  if (!rootDir) return null;
  const root = resolve(rootDir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // 非法 %-编码
  }
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + "/")) return null; // ../ 穿越
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  } catch {
    return null;
  }
  // 资源文件（.js/.css/.png…）缺失就该 404，不能回 index.html 造成诡异的 MIME 错误
  const lastSeg = rel.split("/").pop() || "";
  if (lastSeg.includes(".")) return null;
  const index = join(root, "index.html");
  return existsSync(index) ? index : null;
}

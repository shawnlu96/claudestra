/**
 * 设备 cookie 随使用续发 + 设备请求被拒时记原因。cookie 只在配对时下发一次的话，iOS WebKit 会在 7 天后把它清掉（凭据本身还有效），
 * 所以设备 cookie 鉴权通过的请求每条凭据每 24 小时在响应上再下发一次同值 cookie。api-auth.ts 只在鉴权通过处 noteDeviceAuth，
 * 出口（relay-dispatch.ts）调 renewDeviceCookie；Bearer / peer / E2E 内层的请求没有记号，不会续发。开关 config.json deviceCookieRenew：
 * on 续发、observe（缺省）只记「会续发」、off 什么都不做（tests/device-cookie-renew.test.ts）。
 */
import { DEVICE_COOKIE, deviceCookieHeader } from "../lib/devices.js";
import { readConfigSync, type AppConfig } from "../lib/config-store.js";
import { LogThrottle } from "../lib/log-throttle.js";
import { requestContextOf } from "./request-context.js";

export type RenewMode = NonNullable<AppConfig["deviceCookieRenew"]>;
export type DeviceRefusal = "missing_cookie" | "credential_invalid";

const RENEW_EVERY_MS = 24 * 60 * 60_000;
/** 凭据 id → 上次下发（进程内；重启后第一次使用算满 24 小时） */
const lastIssued = new Map<string, number>();
const authed = new WeakMap<Request, { credentialId: string; token: string }>();
let refusalLog = new LogThrottle();

let modeOf = (): RenewMode => readConfigSync().deviceCookieRenew ?? "observe";
/** 单测注入开关、清掉进程内记录（续发时间、日志限频）；生产不调 */
export function setDeviceCookieRenewForTest(mode: RenewMode | undefined): void {
  modeOf = mode ? () => mode : () => readConfigSync().deviceCookieRenew ?? "observe";
  lastIssued.clear();
  refusalLog = new LogThrottle();
}

/** api-auth.ts：设备 cookie 鉴权全部通过时记一笔（token 就是请求带来的 cookie 值，续发原样写回） */
export function noteDeviceAuth(req: Request, credentialId: string, token: string): void {
  authed.set(req, { credentialId, token });
}

/**
 * 出口调：该续发就返回带 Set-Cookie 的新响应，否则原样返回。只续成功的响应（401 / 403 / 429 这类不带）；
 * 业务自己已经写了设备 cookie 的（退出登录 / 撤销本机时的删除 cookie）不续，否则同名同 Path 的后一条会把删除盖掉
 */
export function renewDeviceCookie(req: Request, res: Response, now = Date.now()): Response {
  const hit = authed.get(req);
  if (!hit || res.status >= 400) return res;
  if (res.headers.getSetCookie().some((c) => c.startsWith(`${DEVICE_COOKIE}=`))) return res;
  if (now - (lastIssued.get(hit.credentialId) ?? -Infinity) < RENEW_EVERY_MS) return res;
  const mode = modeOf();
  if (mode === "off") return res;
  lastIssued.set(hit.credentialId, now);
  const ctx = requestContextOf(req);
  if (mode === "observe") {
    console.log(`[device-cookie] 会续发：凭据 ${hit.credentialId}（来源 ${ctx.source}，${new URL(req.url).pathname}）；deviceCookieRenew=on 才真的下发`);
    return res;
  }
  // Path / Secure 与配对时同一规则（bridge/devices.ts cookieFor）：经中继写机器前缀，中继还会再钉一次
  const cookie = deviceCookieHeader(hit.token, { path: ctx.pathPrefix ? `${ctx.pathPrefix}/` : "/", secure: ctx.https || ctx.source === "relay" });
  const headers = new Headers(res.headers);
  headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** api-auth.ts 两个设备 401 分支：原因 + 来源 + 路径，同一原因同一来源每分钟一行；不记 cookie、token、IP */
export function logDeviceRefusal(req: Request, url: URL, reason: DeviceRefusal, now = Date.now()): void {
  const source = requestContextOf(req).source;
  const log = refusalLog.take(`${reason}/${source}`, now);
  if (!log) return;
  const why = reason === "missing_cookie" ? "没带设备 cookie" : "设备凭据不认（无效、已撤销或过期）";
  console.warn(`🚫 [device-auth] ${why}（${reason}，来源 ${source}）${req.method} ${url.pathname}${log.muted ? `（上一分钟另有 ${log.muted} 条）` : ""}`);
}

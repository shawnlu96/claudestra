/**
 * 浏览器协议的品牌名对照：旧族（claudestra / cstra）与新族（floka）各占一格。旧族取现行字面量，不改；
 * 设备头两族与中继族表（floka-compat/relay/families.ts DEVICE_ROLES）同名，由 tests/floka-browser-protocol.test.ts 钉住相等——
 * 这里不 import 那张表：它反向 import lib/devices.ts，lib/devices.ts 又要用本目录，会成环。
 * 不带品牌的东西（域名、VAPID、/join 路径、/m/<fp> 前缀）不在表里。
 */
export type BrowserFamily = "claudestra" | "floka";
export const BROWSER_FAMILIES: readonly BrowserFamily[] = ["claudestra", "floka"];

export interface BrowserNames {
  /** 设备凭据 cookie（HttpOnly） */
  deviceCookie: string;
  /** 本机一键配对的领取 cookie（HttpOnly，Path=/api/v1/devices/） */
  localClaimCookie: string;
  /** 非 GET/HEAD 的 CSRF 头 */
  deviceHeader: string;
  /** 本机交接（handoff）与前端 localStorage 的键前缀 */
  storagePrefix: string;
  /** 邀请落地页：电脑走浏览器登记的协议、手机走 App scheme */
  webScheme: string;
  appScheme: string;
  /** SW → 页面的消息类型 */
  openAgent: string;
  openAsk: string;
  /** 通知的缺省 tag */
  notificationTag: string;
}

export const BROWSER_NAMES: Readonly<Record<BrowserFamily, BrowserNames>> = {
  claudestra: {
    deviceCookie: "cstra_dev", localClaimCookie: "cstra_local_claim", deviceHeader: "x-cstra-device", storagePrefix: "cstra_",
    webScheme: "web+claudestra", appScheme: "claudestra", openAgent: "cstra-open-agent", openAsk: "cstra-open-ask", notificationTag: "cstra",
  },
  floka: {
    deviceCookie: "floka_dev", localClaimCookie: "floka_local_claim", deviceHeader: "x-floka-device", storagePrefix: "floka_",
    webScheme: "web+floka", appScheme: "floka", openAgent: "floka-open-agent", openAsk: "floka-open-ask", notificationTag: "floka",
  },
};

/** 旧 web 服务的登录 cookie 只有旧族：新族从来没签发过它，没有回滚期可言 */
export const LEGACY_SESSION_COOKIE_NAME = "cstra_session";

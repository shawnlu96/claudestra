/**
 * 浏览器凭据的两族：设备 / 领取 cookie、CSRF 头、Set-Cookie、CORS 允许头、中继放行的 cookie 名。
 *   off：只认、只写旧族，结果与现行代码逐字相同；
 *   observe：判法同 off，另记一行「on 会怎么判」；
 *   on（接收）：两族都认；同一请求两族 cookie 值不同、或两族 CSRF 头同时出现 = 冲突，拒；
 *   write=on：新签的 cookie 两族同值一起种（回滚期：回到旧版本也照样认得最新配对），删时两族一起删。
 * CSRF 不降级：缺头照拒；冲突不会退回「只看旧族」。
 */
import { BROWSER_NAMES, type BrowserFamily } from "./names.js";
import { observeBrowser, type BrowserPolicy } from "./policy.js";

const OLD = BROWSER_NAMES.claudestra, NEW = BROWSER_NAMES.floka;
type CookieRole = "deviceCookie" | "localClaimCookie";
export type CredentialRead = { status: "ok"; value: string | null; family: BrowserFamily | null } | { status: "conflict" };

/** 与 lib/devices.ts 现行 cookieValueFrom 同一写法：取第一个同名的 */
export function rawCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function judge(old: string | null, neu: string | null): CredentialRead {
  if (old !== null && neu !== null) return old === neu ? { status: "ok", value: old, family: "claudestra" } : { status: "conflict" };
  if (neu !== null) return { status: "ok", value: neu, family: "floka" };
  return { status: "ok", value: old, family: old !== null ? "claudestra" : null };
}

export function readBrowserCookie(header: string | null, role: CookieRole, p: BrowserPolicy): CredentialRead {
  const old = rawCookie(header, OLD[role]);
  if (p.receive === "on") return judge(old, rawCookie(header, NEW[role]));
  if (p.receive === "observe") {
    const verdict = judge(old, rawCookie(header, NEW[role]));
    if (verdict.status === "conflict") observeBrowser(role, "on would reject conflicting cookie families");
    else if (verdict.family === "floka") observeBrowser(role, "on would accept new cookie family");
  }
  return { status: "ok", value: old, family: old !== null ? "claudestra" : null };
}

type HeaderSource = Pick<Headers, "get">;
/** 两族 CSRF 头：on 档只许出现一族（与中继 readBrandGroup 的设备头同口径） */
export function readCsrfHeader(h: HeaderSource, p: BrowserPolicy): CredentialRead {
  const old = h.get(OLD.deviceHeader), neu = h.get(NEW.deviceHeader);
  const both = old !== null && neu !== null;
  if (p.receive === "on") {
    if (both) return { status: "conflict" };
    return { status: "ok", value: neu ?? old, family: neu !== null ? "floka" : old !== null ? "claudestra" : null };
  }
  if (p.receive === "observe" && neu !== null) observeBrowser("csrf", both ? "on would reject both header families" : "on would accept new header family");
  return { status: "ok", value: old, family: old !== null ? "claudestra" : null };
}

/** 非 GET/HEAD 必须带 CSRF 头；冲突一律算没带 */
export function csrfPasses(method: string, h: HeaderSource, p: BrowserPolicy): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  const r = readCsrfHeader(h, p);
  return r.status === "ok" && r.value !== null;
}

/**
 * 给 Set-Cookie 用的那几个名字与动作：旧族永远照写（种 / 删）；新族 write=on 才同值种，删除时 receive=on 就一起删。
 * receive=on 而 write 没开时种旧族，同时删掉新族：之前 write=on 种下的新族镜像（或回滚到旧版本后重新配对留下的）
 * 不会再跟着更新，留着就与新旧族值不同 → 冲突 → 401。off / observe 只有旧族一条，与现行逐字相同。
 */
export function cookieWritePlan(role: CookieRole, p: BrowserPolicy, clearing: boolean): { name: string; clear: boolean }[] {
  const plan = [{ name: OLD[role], clear: clearing }];
  if (p.receive !== "on") return plan;
  plan.push({ name: NEW[role], clear: clearing || p.write !== "on" });
  return plan;
}

/**
 * 两族 cookie 冲突时要删的新族名。旧族是唯一每次都写的一族（任何档位、任何版本），新族只是同值镜像，
 * 冲突只可能是新族过期——拒掉这一请求（冲突照拒，不替请求挑一把），同时删掉新族，下一请求只剩旧族、按旧族判。
 */
export const staleMirrorName = (role: CookieRole): string => NEW[role];

/** 中继 /m/<fp>/ 放给机器、放回浏览器的 cookie 名（RELAY 清洗链接线用；off / observe 与现行只放旧族相同） */
export function relayCookieNames(p: BrowserPolicy): string[] {
  return p.receive === "on" ? [OLD.deviceCookie, NEW.deviceCookie] : [OLD.deviceCookie];
}

/** CORS 允许头：base 里列了旧族设备头的，on 档补上新族；off / observe 原样返回 */
export function allowHeadersWith(base: string, p: BrowserPolicy): string {
  if (p.receive !== "on") return base;
  const names = base.split(",").map((s) => s.trim().toLowerCase());
  return names.includes(OLD.deviceHeader) && !names.includes(NEW.deviceHeader) ? `${base}, ${NEW.deviceHeader}` : base;
}


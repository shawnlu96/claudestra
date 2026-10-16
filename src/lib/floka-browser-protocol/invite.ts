/**
 * 邀请链接的 scheme。旧链接（web+claudestra:<码>、claudestra://join#<码>）永远能打开；新 scheme（web+floka: / floka://）
 * 接收 on 才认，write=on 时落地页才给新 scheme。码本身（base64url 的 v2 邀请）两族相同，换 scheme 不换码。
 */
import { BROWSER_FAMILIES, BROWSER_NAMES, type BrowserFamily } from "./names.js";
import type { BrowserPolicy } from "./policy.js";

export interface InviteSchemes { web: string; app: string }

/** 落地页按钮的前缀：电脑 `<web>:` + 码，手机 `<app>://join#` + 码 */
export function inviteSchemes(p: BrowserPolicy): InviteSchemes {
  const n = BROWSER_NAMES[p.receive === "on" && p.write === "on" ? "floka" : "claudestra"];
  return { web: `${n.webScheme}:`, app: `${n.appScheme}://join#` };
}

const CODE_RE = /^[A-Za-z0-9_-]{16,8192}$/;
/** 链接 → { family, code }；scheme 不认、码形状不对 → null。新族只在接收 on 时认 */
export function parseInviteLink(link: string, p: BrowserPolicy): { family: BrowserFamily; code: string } | null {
  const s = link.trim();
  for (const family of BROWSER_FAMILIES) {
    if (family === "floka" && p.receive !== "on") continue;
    const n = BROWSER_NAMES[family];
    for (const prefix of [`${n.webScheme}:`, `${n.appScheme}://join#`]) {
      if (s.toLowerCase().startsWith(prefix)) {
        const code = s.slice(prefix.length);
        return CODE_RE.test(code) ? { family, code } : null;
      }
    }
  }
  return null;
}

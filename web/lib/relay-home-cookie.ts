/**
 * 经中继登录时给中继父域记一个只含 slug 的 cookie（cstra_home）：中继落地页 /i 靠它把邀请链接直接送回这台机器的 /join
 * （docs/relay/protocol.md §6）。密码 / passkey / 配对码三种登录都要设，否则只有配对过的浏览器能享受「邀请直达」。
 * 只在请求确实经中继进来时设（bridge 隧道会盖 x-claudestra-relay-base，且 Host 是 <slug>.<base>）；Lax 才会随点链接的
 * 顶层跳转一起发，Strict 会被跨站导航丢掉。
 */
const HOME_COOKIE = "cstra_home";
const HOME_COOKIE_DAYS = 365;

export interface HomeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  sameSite: "lax";
  httpOnly: boolean;
  maxAge: number;
}

/** 纯函数（tests/web-relay-home-cookie.test.ts）：不是经中继来的请求返回 null */
export function relayHomeCookie(headers: { get(name: string): string | null }): HomeCookie | null {
  const base = (headers.get("x-claudestra-relay-base") || "").trim().toLowerCase();
  const host = (headers.get("x-forwarded-host") || headers.get("host") || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!base || !host.endsWith(`.${base}`)) return null;
  const slug = host.slice(0, host.length - base.length - 1);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)) return null;
  return { name: HOME_COOKIE, value: slug, domain: base, path: "/", secure: true, sameSite: "lax", httpOnly: true, maxAge: HOME_COOKIE_DAYS * 24 * 3600 };
}

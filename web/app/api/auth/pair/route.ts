export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkRateLimit, createSession, sessionCookie } from "@/lib/services/auth.service";
import { BRIDGE } from "@/lib/chat/bridge-api";
import { requestClientIp } from "@/lib/client-ip";

/**
 * 配对码登录（公开路由，guard PUBLIC_ROUTES 已登记）：`claudestra pair` 在这台机器上生成的一次性短码，
 * 手机 / 别的浏览器经中继打开 /pair 填进来，就拿到和密码登录同款的会话。
 * 短码的真伪、一次性、尝试次数都由 bridge 的回环控制路由判（src/bridge/relay-pairing.ts），这里只做
 * 每 IP 限流 + 发会话：bridge 不在跑就配不了对，和密码登录依赖本机 SSH 是一个道理。
 */
const HOME_COOKIE = "cstra_home";
const HOME_COOKIE_DAYS = 365;

export async function POST(request: Request) {
  const j = (await request.json().catch(() => ({}))) as { code?: unknown }; // 不是 JSON 就当没带 code，下面按 400 拒
  const code = typeof j.code === "string" ? j.code.trim() : "";
  if (!code) return NextResponse.json({ error: "配对码不能为空" }, { status: 400 });
  const ip = requestClientIp(request);
  if (!checkRateLimit(`pair:${ip || "unknown"}`)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  let r: Response;
  try {
    r = await fetch(`${BRIDGE}/relay/pair/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error(`[pair] bridge 没响应: ${(e as Error).message}`);
    return NextResponse.json({ error: "这台电脑的 Claudestra 没有响应，请稍后再试" }, { status: 502 });
  }
  // bridge 回的不是 JSON（老版本没有这个路由回 404 文本）：按空对象走下面的「无效」分支，状态码照样判
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; username?: string };
  if (!r.ok || !body.ok || !body.username) {
    const status = r.status === 429 ? 429 : 400;
    return NextResponse.json({ error: body.error || "配对码无效或已过期，请在电脑上重新运行 claudestra pair" }, { status });
  }
  const session = createSession(body.username);
  const res = NextResponse.json({ data: { username: body.username } });
  res.cookies.set(sessionCookie(session.id));
  // 经中继进来的：在中继的父域记一个只含 slug 的 cookie，中继落地页 /i 靠它把邀请送回这台机器
  // （docs/relay/protocol.md §6）。Lax 才会随点链接的顶层跳转一起发；Strict 会被跨站导航丢掉。
  const base = request.headers.get("x-claudestra-relay-base") || "";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  if (base && host.toLowerCase().endsWith(`.${base.toLowerCase()}`)) {
    const slug = host.slice(0, host.length - base.length - 1);
    res.cookies.set({
      name: HOME_COOKIE, value: slug, domain: base, path: "/", secure: true, sameSite: "lax", httpOnly: true,
      maxAge: HOME_COOKIE_DAYS * 24 * 3600,
    });
  }
  return res;
}

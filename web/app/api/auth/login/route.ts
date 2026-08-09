export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  verifySSH,
  checkRateLimit,
  createSession,
  SESSION_COOKIE,
} from "@/lib/services/auth.service";
import { checkLockout, recordFailure, clearFailures } from "@/lib/services/auth-hardening";
import { totpEnabled, verifySecondFactor } from "@/lib/services/totp.service";

const SESSION_DAYS = 7;

export async function POST(request: Request) {
  // host/port 不再从 body 取——verifySSH 硬编码本机（防未认证 SSH-target 注入 + SSRF）
  // 两种载荷:JSON(水合后的 fetch)/ 表单(未水合的原生 <form> 提交——JS 慢/失败
  // 时登录也必须能成,2026-07-14「按钮一直转圈」)。表单路径成败都用 303 重定向,
  // Location 用相对路径(TLS 反代后端是 http,绝对 URL 会把浏览器带回明文)。
  const isForm = (request.headers.get("content-type") || "").includes("form");
  let username = "";
  let password = "";
  let code = ""; // 第二期:TOTP 验证码/恢复码,与密码同请求提交(不引入中间态 token)
  if (isForm) {
    const fd = await request.formData().catch(() => null);
    username = String(fd?.get("username") || "");
    password = String(fd?.get("password") || "");
    code = String(fd?.get("code") || "");
  } else {
    const j = (await request.json().catch(() => ({}))) as { username?: string; password?: string; code?: string };
    username = j.username || "";
    password = j.password || "";
    code = j.code || "";
  }
  const formRedirect = (to: string) =>
    new NextResponse(null, { status: 303, headers: { Location: to } });

  if (!username || !password) {
    if (isForm) return formRedirect("/login?e=empty");
    return NextResponse.json(
      { error: "用户名和密码不能为空" },
      { status: 400 }
    );
  }

  // 限流按客户端 IP（反代设置 x-forwarded-for），换 username 也换不掉桶；
  // 无 IP 时回退 username 至少有个限。
  const xff = request.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || "";
  const rlKey = ip ? `ip:${ip}` : `user:${username}`;
  if (!checkRateLimit(rlKey)) {
    if (isForm) return formRedirect("/login?e=rate");
    return NextResponse.json(
      { error: "登录尝试过于频繁，请稍后再试" },
      { status: 429 }
    );
  }

  // 累进封禁：处于锁定期直接拒（在密码校验之前——锁住就不再消耗 SSH 校验）。
  const lock = checkLockout(rlKey);
  if (lock.locked) {
    if (isForm) return formRedirect("/login?e=locked");
    return NextResponse.json(
      { error: `尝试失败次数过多，账户已临时锁定，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } }
    );
  }

  const ok = await verifySSH(username, password);
  if (!ok) {
    const r = recordFailure(rlKey); // 累进封禁计账；达阈值即进入锁定期
    if (isForm) return formRedirect(r.lockedForMin > 0 ? "/login?e=locked" : "/login?e=cred");
    return NextResponse.json(
      {
        error: r.lockedForMin > 0
          ? `用户名或密码错误，失败次数过多，已锁定 ${r.lockedForMin} 分钟`
          : "用户名或密码错误",
      },
      { status: 401 }
    );
  }

  // 第二因素（TOTP，第二期）。密码对了但 2FA 没过一律不发 session；失败同样计入
  // 累进封禁——否则 6 位码可被无限爆破，等于没加这道门。
  let recoveryNote: { usedRecovery: boolean; remaining: number } | undefined;
  if (totpEnabled()) {
    if (!code) {
      if (isForm) return formRedirect("/login?e=totp");
      return NextResponse.json({ error: "需要两步验证码", needTotp: true }, { status: 401 });
    }
    const v = verifySecondFactor(code);
    if (!v.ok) {
      const r = recordFailure(rlKey);
      if (isForm) return formRedirect(r.lockedForMin > 0 ? "/login?e=locked" : "/login?e=totpbad");
      return NextResponse.json(
        {
          error: r.lockedForMin > 0
            ? `验证码不正确，失败次数过多，已锁定 ${r.lockedForMin} 分钟`
            : "验证码不正确",
          needTotp: true,
        },
        { status: 401 }
      );
    }
    if (v.usedRecovery) recoveryNote = { usedRecovery: true, remaining: v.remaining ?? 0 };
  }

  clearFailures(rlKey); // 登录成功清账
  const session = createSession(username);
  const res = isForm
    ? formRedirect("/chat")
    : NextResponse.json({ data: { username, ...(recoveryNote ? { recovery: recoveryNote } : {}) } });
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  // Secure 默认**关**：这套 web 常经 Tailscale / 本机的明文 HTTP 访问，Secure cookie
  // 在 HTTP 下会被浏览器直接丢弃 → 登录成功但 cookie 存不下、一直跳回登录页。
  // 只有前面是 HTTPS 反代终止 TLS 的部署才设 COOKIE_SECURE=on 显式开。
  // (httpOnly + sameSite=strict 已提供 XSS/CSRF 防护，Secure 只防明文窃听。)
  const secure = process.env.COOKIE_SECURE === "on";

  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge,
  });

  return res;
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, checkRateLimit } from "@/lib/services/auth.service";
import { checkLockout, recordFailure, clearFailures } from "@/lib/services/auth-hardening";
import { beginAuthentication, finishAuthentication } from "@/lib/services/webauthn.service";

/**
 * Passkey 登录（**未鉴权入口**，与管理端点分开）。
 *
 * 两步：POST {action:"begin"} 拿挑战 → 浏览器唤起指纹/面容 → POST
 * {action:"finish"} 验签发 session。
 *
 * 安全说明：passkey 本身不可爆破（挑战-响应 + 设备私钥），但入口仍挂同一套
 * 限速与累进封禁——防的是有人拿这个端点当探测面刷（begin 会暴露"该域有没有
 * 注册过 passkey"）。验签失败一律计账。
 *
 * ⚠️ passkey 通过即发 session，**不再要 TOTP**：passkey 已经是「设备持有 +
 * 用户验证（指纹/面容/PIN）」的双因素，再叠一层动态码没有安全收益，只有体验
 * 损耗。这与主流实现（Google/Apple/GitHub）一致。
 */

const SESSION_DAYS = 7;

function rlKeyOf(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || "";
  return ip ? `ip:${ip}` : "passkey:unknown";
}

export async function POST(request: Request) {
  const rlKey = rlKeyOf(request);
  if (!checkRateLimit(rlKey)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const lock = checkLockout(rlKey);
  if (lock.locked) {
    return NextResponse.json(
      { error: `失败次数过多，已临时锁定，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    challengeId?: string;
    response?: unknown;
  };

  if (body.action === "begin") {
    const r = await beginAuthentication(request);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, ...r });
  }

  if (body.action === "finish") {
    const r = await finishAuthentication(
      request,
      String(body.challengeId || ""),
      body.response as never,
    );
    if ("error" in r) {
      recordFailure(rlKey);
      return NextResponse.json({ error: r.error }, { status: 401 });
    }
    clearFailures(rlKey);

    // 用户名取本机登录名：passkey 是设备绑定的，这套系统本就是单用户
    const session = createSession(process.env.USER || "claudestra");
    const res = NextResponse.json({ data: { username: session.username, via: r.credName } });
    res.cookies.set(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "on",
      path: "/",
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
    return res;
  }

  return NextResponse.json({ error: "未知 action" }, { status: 400 });
}

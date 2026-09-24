export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkRateLimit, createSession, sessionCookie } from "@/lib/services/auth.service";
import { issueResumeToken, redeemResumeToken } from "@/lib/services/resume-token";
import { requestClientIp } from "@/lib/client-ip";

/**
 * 公开路由（此时恰恰没有 cookie）：拿续期凭证换一个新会话 + 一枚新凭证（旧的当场作废）。
 * 凭证 ≈256 bit 随机数，猜不出来；限流只是防有人拿它刷数据库。
 */
export async function POST(request: Request) {
  const ip = requestClientIp(request);
  if (!checkRateLimit(`resume:${ip || "unknown"}`)) {
    return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
  }
  const { token } = (await request.json().catch(() => ({}))) as { token?: unknown }; // 坏 JSON 当没带凭证，下面回 401
  const r = typeof token === "string" ? redeemResumeToken(token) : null;
  if (!r) return NextResponse.json({ error: "凭证无效或已过期" }, { status: 401 });
  const session = createSession(r.username, new Date(r.expiresAt));
  const res = NextResponse.json({ token: issueResumeToken(r.username, r.expiresAt) });
  const leftSec = Math.floor((Date.parse(r.expiresAt) - Date.now()) / 1000);
  res.cookies.set(sessionCookie(session.id, Math.max(60, leftSec)));
  return res;
}

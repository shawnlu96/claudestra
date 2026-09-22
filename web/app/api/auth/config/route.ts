export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/bff";
import { readAuthConfig, setBruteForce } from "@/lib/services/auth-hardening";

/**
 * 登录安全配置（设置页「登录安全」板块）。第一期只有累进封禁开关可改；
 * TOTP / Passkey 的开关由各自的 enroll 流程管（在这里只读展示状态）。
 * 敏感材料（totp_secret 等）永不经此端点出后端。
 */

export const GET = withAuth(async () => {
  return NextResponse.json(readAuthConfig());
});

export const PUT = withAuth(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as { bruteForceOn?: unknown };
  if (typeof body.bruteForceOn !== "boolean") {
    return NextResponse.json({ error: "bruteForceOn 必须是布尔值" }, { status: 400 });
  }
  setBruteForce(body.bruteForceOn);
  return NextResponse.json({ ok: true, ...readAuthConfig() });
});

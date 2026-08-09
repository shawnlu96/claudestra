export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { renderSVG } from "uqr";
import { isAuthed } from "@/lib/api-auth";
import { getSessionFromCookie } from "@/lib/services/auth.service";
import {
  beginEnroll,
  completeEnroll,
  disableTotp,
  totpEnabled,
  regenerateRecoveryCodes,
  recoveryCodesRemaining,
} from "@/lib/services/totp.service";

/**
 * TOTP 两步验证管理（设置页）。全部要求已登录 session。
 *
 * POST {action}:
 *  - "begin"    → 生成候选 secret，返回 otpauth URI + 二维码 SVG + 手输 secret
 *  - "complete" {code} → 验一次码，通过才激活，返回 10 个恢复码（仅此一次）
 *  - "disable"  → 关闭并清空 secret + 恢复码
 *  - "regen"    → 重新生成恢复码（旧的作废）
 *
 * secret 只在 begin 的响应里出现一次（用户要手输进认证器）；此后任何 GET
 * 都不回传 secret。
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  return NextResponse.json({
    enabled: totpEnabled(),
    recoveryRemaining: recoveryCodesRemaining(),
  });
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { action?: string; code?: string };
  const action = String(body.action || "");

  if (action === "begin") {
    const session = await getSessionFromCookie();
    const { secret, uri } = beginEnroll(session?.username || "claudestra");
    return NextResponse.json({ ok: true, secret, uri, qrSvg: renderSVG(uri, { border: 1 }) });
  }

  if (action === "complete") {
    const r = completeEnroll(String(body.code || ""));
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, recoveryCodes: r.recoveryCodes });
  }

  if (action === "disable") {
    disableTotp();
    return NextResponse.json({ ok: true, enabled: false });
  }

  if (action === "regen") {
    if (!totpEnabled()) return NextResponse.json({ error: "两步验证未启用" }, { status: 400 });
    return NextResponse.json({ ok: true, recoveryCodes: regenerateRecoveryCodes() });
  }

  return NextResponse.json({ error: "未知 action" }, { status: 400 });
}

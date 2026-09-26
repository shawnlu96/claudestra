export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authed } from "@/lib/bff";
import { BRIDGE } from "@/lib/chat/bridge-api";

/**
 * 网页里「配对新设备」：让 bridge 签一个一次性短码（回环控制路由 POST /relay/pair/new，与 `claudestra pair` 同源），
 * 回 { code, display, url, expiresAt }，卡片据此画二维码。中继没连上时 bridge 回 409，原样透传给卡片解释。
 */
export const POST = authed(async () => {
  const r = await fetch(`${BRIDGE}/relay/pair/new`, { method: "POST", signal: AbortSignal.timeout(5000) });
  const body = await r.json().catch(() => ({ ok: false, error: `bridge ${r.status}` })); // 老 bridge 回 404 文本：按失败处理
  const status = r.ok ? 200 : r.status === 409 ? 409 : 502;
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
});

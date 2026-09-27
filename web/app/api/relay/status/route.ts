export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authed } from "@/lib/bff";
import { BRIDGE } from "@/lib/chat/bridge-api";

/**
 * 中继连接状态（Peer 面板的「中继」卡）：bridge 的回环控制路由 GET /relay/status。
 * 它不在 /api/v1 下、不要 Bearer，所以不走 bridgeGet；老版本 bridge 没有这个路由会回 404 文本 → 502，卡片显示读不到。
 */
export const GET = authed(async () => {
  const r = await fetch(`${BRIDGE}/relay/status`, { signal: AbortSignal.timeout(5000) });
  const body = await r.json().catch(() => ({ ok: false, error: `bridge ${r.status}` })); // 不是 JSON = 老 bridge 的 404 文本，按读不到处理
  return NextResponse.json(body, { status: r.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } });
});

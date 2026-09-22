export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 归档保留天数（BFF 代理 Bridge /api/v1/settings/archive-retention）。
 * 0 = 永不自动清理；缺省 90（超期由每日兜底清理）。
 */
export const GET = authedLegacy(async () => {
  const data = await bridgeGet<{ days?: number; defaultDays?: number }>(
    "/settings/archive-retention",
    { timeoutMs: 4000 },
  );
  return NextResponse.json({ data });
});

export const POST = authedLegacy(async (request: Request) => {
  const body = await request.json().catch(() => ({}));
  const data = await bridgePost("/settings/archive-retention", body);
  return NextResponse.json({ data });
});

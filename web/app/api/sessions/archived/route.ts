export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/** 归档清单（BFF 代理 Bridge GET /api/v1/sessions/archived）。侧栏「归档」栏的数据源。 */
export const GET = authedLegacy(async () => {
  const data = await bridgeGet<{ entries?: unknown[] }>("/sessions/archived", { timeoutMs: 8000 });
  return NextResponse.json({ data: { entries: data?.entries ?? [] } });
});

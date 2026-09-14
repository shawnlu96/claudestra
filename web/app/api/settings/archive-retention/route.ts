export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 归档保留天数（BFF 代理 Bridge /api/v1/settings/archive-retention）。
 * 0 = 永不自动清理；缺省 90（超期由每日兜底清理）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const data = await bridgeGet<{ days?: number; defaultDays?: number }>(
      "/settings/archive-retention",
      { timeoutMs: 4000 },
    );
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const data = await bridgePost("/settings/archive-retention", body);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

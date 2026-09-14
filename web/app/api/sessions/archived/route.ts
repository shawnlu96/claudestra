export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/** 归档清单（BFF 代理 Bridge GET /api/v1/sessions/archived）。侧栏「归档」栏的数据源。 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const data = await bridgeGet<{ entries?: unknown[] }>("/sessions/archived", { timeoutMs: 8000 });
    return NextResponse.json({ data: { entries: data?.entries ?? [] } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

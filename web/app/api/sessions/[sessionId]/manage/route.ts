export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 未纳管会话的处置（BFF 代理 Bridge POST /api/v1/sessions/:sessionId/manage）。
 * action=archive：先快照进归档目录再删原文件（列表不再显示，可逆）
 * action=delete ：只删原文件（前端二次确认）
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { sessionId } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    runtime?: string;
    cwd?: string;
  };
  try {
    const data = await bridgePost(`/sessions/${encodeURIComponent(sessionId)}/manage`, body);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

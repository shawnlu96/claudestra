export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/** 归档条目回归（BFF 代理 Bridge POST /api/v1/sessions/archived/:id/restore）。 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const data = await bridgePost(`/sessions/archived/${encodeURIComponent(id)}/restore`, {});
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

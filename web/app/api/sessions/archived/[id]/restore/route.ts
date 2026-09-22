export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/** 归档条目回归（BFF 代理 Bridge POST /api/v1/sessions/archived/:id/restore）。 */
export const POST = authedLegacy(async (
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
) => {
  const { id } = await ctx.params;
  const data = await bridgePost(`/sessions/archived/${encodeURIComponent(id)}/restore`, {});
  return NextResponse.json({ ok: true, data });
});

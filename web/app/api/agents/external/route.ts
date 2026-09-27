export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authed, HttpError } from "@/lib/bff";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";

/** 切 external 闸门：代理 Bridge POST /api/v1/agents/:name/external {on, confirm}；正在共享时关闭要 confirm=会话名，否则 409 透传。 */
export const POST = authed(async (req) => {
  const body = (await req.json().catch(() => null /* 非 JSON body：下面按缺参回 400 */)) as { name?: string; on?: boolean; confirm?: string } | null;
  const name = body?.name?.trim();
  if (!name || typeof body?.on !== "boolean") throw new HttpError(400, "name and on required");
  return NextResponse.json(await bridgePost(`/agents/${encodeURIComponent(apiAgentName(name))}/external`, { on: body.on, confirm: body.confirm }));
});

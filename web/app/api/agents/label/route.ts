export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authed, HttpError } from "@/lib/bff";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";

/** 设显示名：代理 Bridge POST /api/v1/agents/:name/label {label}（空串 = 清除）。 */
export const POST = authed(async (req) => {
  const body = (await req.json().catch(() => null /* 非 JSON body：下面按缺参回 400 */)) as { name?: string; label?: string } | null;
  const name = body?.name?.trim();
  if (!name || typeof body?.label !== "string") throw new HttpError(400, "name and label required");
  return NextResponse.json(await bridgePost(`/agents/${encodeURIComponent(apiAgentName(name))}/label`, { label: body.label }));
});

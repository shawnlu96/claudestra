export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authed, HttpError } from "@/lib/bff";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";

/** 会话详情：代理 Bridge GET /api/v1/agents/:name/info（registry 字段 + 正在共享给哪些 peer）。 */
export const GET = authed(async (req) => {
  const name = new URL(req.url).searchParams.get("name")?.trim();
  if (!name) throw new HttpError(400, "name required");
  return NextResponse.json(await bridgeGet(`/agents/${encodeURIComponent(apiAgentName(name))}/info`));
});

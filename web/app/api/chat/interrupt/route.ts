export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 一键中断：代理 Bridge POST /api/v1/agents/:name/interrupt（fork additive
 * 端点，tmux C-c；master → master:0）。
 */
export const POST = authedLegacy(async (request: Request) => {
  const { agent } = await request.json().catch(() => ({}));
  if (!agent) {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }
  const result = await bridgePost<{ ok: boolean; agent?: string }>(
    `/agents/${encodeURIComponent(apiAgentName(agent))}/interrupt`,
    {},
    { timeoutMs: 10_000 }
  );
  return NextResponse.json({ ok: true, agent: result.agent });
}, { okFalse: true, errorPrefix: "打断失败: " });

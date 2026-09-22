export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 某 agent 的 Claude Code 原生任务清单——代理 Bridge GET /api/v1/agents/:name/tasks
 * (owner 2026-07-16:「console 里的 todo 适配到 Web UI 上」)。
 */
export const GET = authedLegacy(async (request: Request) => {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return NextResponse.json({ error: "missing agent" }, { status: 400 });
  const r = await bridgeGet<{
    ok: boolean;
    tasks: { id: string; subject: string; activeForm?: string; status: string; blockedBy: string[] }[];
  }>(`/agents/${encodeURIComponent(apiAgentName(agent))}/tasks`, { timeoutMs: 8000 });
  return NextResponse.json({ data: r.tasks || [] });
});

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";
import { st } from "@/lib/server-lang";

/**
 * 某 agent 可用的 slash 命令清单（composer 输入 / 弹出的命令面板数据源）。
 * 代理 Bridge GET /api/v1/agents/:name/skills（builtin + 全局 skill +
 * 该 agent 项目 skill,fork 端点）。
 */
export const GET = authedLegacy(async (request: Request) => {
  const agent = new URL(request.url).searchParams.get("agent");
  if (!agent) return NextResponse.json({ error: "missing agent" }, { status: 400 });
  const r = await bridgeGet<{ ok: boolean; commands: unknown[] }>(
    `/agents/${encodeURIComponent(apiAgentName(agent))}/skills`,
    { timeoutMs: 8000 }
  );
  return NextResponse.json({ commands: r.commands || [] });
}, { errorPrefix: async () => `${await st("Bridge 不可达", "Bridge unreachable")}: ` });

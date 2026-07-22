export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost, apiAgentName } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * per-会话切换模型/effort：代理 Bridge POST /api/v1/agents/:name/claude-settings
 * （fork additive 端点）。409 = agent 回合进行中，原样透传给前端提示。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, model, effort } = await request.json().catch(() => ({}));
  if (!agent || typeof agent !== "string") {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }
  if (!model && !effort) {
    return NextResponse.json({ error: "model / effort 至少一项" }, { status: 400 });
  }
  try {
    const result = await bridgePost(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/claude-settings`,
      { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      { timeoutMs: 20_000 }
    );
    return NextResponse.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    // bridgePost 对非 2xx 抛错并带状态语义——回合中 409 转给前端做友好提示
    const busy = /409|回合/.test(msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: busy ? 409 : 502 }
    );
  }
}

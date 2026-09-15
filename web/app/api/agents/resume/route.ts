export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 收编一个会话成正式 agent（BFF 代理 Bridge POST /api/v1/agents/resume）。
 *
 * 场景：侧栏「未纳管会话」里看到一个 pi-web 起的 Pi 会话 / 终端里手敲的会话 →
 * 起个名字收编 → 它变成正式 agent（建 tmux 窗口 + 频道、能对话、进 agent 列表）。
 * 桥接侧**同步执行**（起窗口 + 等就绪约 10-40s）并把 manager 的结果原样带回：
 * 失败要能说明原因（最常见是名字与已有 agent 撞车 →「已存在」）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, sessionId, runtime, cwd } = (await request.json().catch(() => ({}))) as {
    agent?: string;
    sessionId?: string;
    runtime?: string;
    cwd?: string;
  };
  if (!agent || !sessionId) {
    return NextResponse.json({ error: "agent 和 sessionId 不能为空" }, { status: 400 });
  }
  try {
    // 同步等结果（桥接侧起窗口 + 等就绪约 10-40s；失败原因在这一跳就会带回来）
    const json = await bridgePost<Record<string, unknown>>(
      "/agents/resume",
      {
        agent,
        sessionId,
        ...(runtime ? { runtime } : {}),
        ...(cwd ? { cwd } : {}),
      },
      { timeoutMs: 180_000 }
    );
    return NextResponse.json({ data: json });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

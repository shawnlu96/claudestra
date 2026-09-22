export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";
import { bridgeErrorResponse, bridgeErrorStatus } from "@/lib/bff";

/**
 * 清空会话：代理 Bridge POST /api/v1/agents/:name/clear（fork additive 端点）。
 *
 * Bridge 侧只做原生的事：tmux 打 /clear + 后台会话轮转收尾（旧会话归档 →
 * registry 切 sessionId → jsonl-watcher 重绑）。回合进行中 Bridge 返 409。
 * clear 后要不要发开机指令是前端（chat-store.clearAgent）的事，本路由零感知。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent } = (await request.json().catch(() => ({}))) as { agent?: string };
  if (!agent) {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }
  try {
    const result = await bridgePost<{ ok: boolean; agent?: string }>(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/clear`,
      {},
      { timeoutMs: 15_000 }
    );
    return NextResponse.json({ ...result, ok: true });
  } catch (e) {
    // bridge 的 409（回合进行中）按状态码透传，前端提示「先停止再 clear」——以前靠正则
    // 从错误文案里猜 409；其余 4xx 也照原样透传（bff.ts 的口径）
    if (bridgeErrorStatus(e) === 409) return bridgeErrorResponse(e);
    return bridgeErrorResponse(e, `${await st("clear 失败", "Clear failed")}: `);
  }
}

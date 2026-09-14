export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";

/**
 * 全机器会话清单（BFF 代理 Bridge GET /api/v1/session-list）。
 *
 * 与 /api/agents 的区别（这是侧栏新增「未纳管会话」分区的理由）：
 *   - /api/agents     = **纳管**的 agent（有频道、能对话）
 *   - /api/sessions   = 机器上**所有**会话（含 pi-web 起的 Pi 会话、终端手敲的），
 *                       `agentName === null` 即未纳管：能看历史、能收编，但不能对话
 * 数据由 manager 扫盘得到（两种 runtime 合并，按最近活动排序）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const json = await bridgeGet<{ count?: number; sessions?: unknown[] }>("/session-list", {
      timeoutMs: 25_000,
    });
    return NextResponse.json({
      data: { count: json.count ?? 0, sessions: json.sessions ?? [] },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `${await st("Bridge 不可达", "Bridge unreachable")}: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

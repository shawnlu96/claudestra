export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * v2.24+ 全体重启（owner 2026-09-22：Claude Code 被意外登出后，在一个会话里重新
 * 登录，其它会话照样"未登录"——凭证只在进程启动时读一次，跑着的进程不会回头重读）。
 *
 * POST → 点火，立刻回 202。**不能等它返回**：十几个 agent 逐个 `--resume` 拉起是
 *        分钟级，HTTP 早超时。agent 全部 resume 原会话，上下文不丢；大总管由
 *        launcher 在 15 秒内用交接单接回。
 * GET  → 重启日志末尾，前端轮询看进度（真正的"回来了"看侧栏会话状态）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgePost("/restart-all", { includeMaster: true }));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgeGet("/restart-all/log?tail=40"));
  } catch (e) {
    return NextResponse.json({ ok: true, lines: [], note: (e as Error).message });
  }
}

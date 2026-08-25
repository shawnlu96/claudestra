export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * mem0 记忆卫生配置(代理 Bridge /api/v1/memory-hygiene,全权 token)。
 * GET  → 当前状态(是否启用/频率/上次/下次运行)
 * POST → {enabled, freq} 写入(bridge 侧同步 cron 任务)
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgeGet("/memory-hygiene"));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { enabled?: boolean; freq?: string };
  try {
    return NextResponse.json(await bridgePost("/memory-hygiene", body));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

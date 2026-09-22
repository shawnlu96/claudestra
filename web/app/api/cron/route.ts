export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 定时任务管理(代理 Bridge /api/v1/cron*,全权 token)。
 * GET  → 任务清单(prompt 全文)
 * POST → {action: add|toggle|remove|edit, id?, ...} 分发
 */
export const GET = authedLegacy(async () => {
  return NextResponse.json(await bridgeGet("/cron"));
}, { okFalse: true });

export const POST = authedLegacy(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    name?: string;
    schedule?: string;
    prompt?: string;
    dir?: string;
    targetAgent?: string;
    effort?: string;
    project?: string | null;
  };
  const { action, id } = body;
  let result: unknown;
  if (action === "add") {
    result = await bridgePost("/cron", body);
  } else if (action === "toggle" || action === "remove" || action === "edit") {
    if (!id) return NextResponse.json({ ok: false, error: "id 不能为空" }, { status: 400 });
    result = await bridgePost(`/cron/${encodeURIComponent(id)}/${action}`, body);
  } else {
    return NextResponse.json({ ok: false, error: `未知 action: ${action}` }, { status: 400 });
  }
  return NextResponse.json(result);
}, { okFalse: true });

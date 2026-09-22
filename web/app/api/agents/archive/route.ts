export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { authed, HttpError } from "@/lib/bff";

/**
 * 给某个 agent 的当前会话做快照（BFF 代理 Bridge POST /api/v1/agents/:name/archive）。
 * 语义 = CLI `manager archive <name>`：**只快照，不动 agent 本身**（非破坏性）。
 * 侧栏 agent 行左滑「归档」用它；「删除」才是 kill + 移除条目。
 * 返回形状 `{ok:true, data}` 与其它生命周期路由不同，是前端既有约定，保持不动。
 */
export const POST = authed(async (request) => {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body?.name || "");
  if (!name) throw new HttpError(400, "缺少 name");
  const data = await bridgePost(`/agents/${encodeURIComponent(name)}/archive`, {});
  return NextResponse.json({ ok: true, data });
});

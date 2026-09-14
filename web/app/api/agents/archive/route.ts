export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 给某个 agent 的当前会话做快照（BFF 代理 Bridge POST /api/v1/agents/:name/archive）。
 * 语义 = CLI `manager archive <name>`：**只快照，不动 agent 本身**（非破坏性）。
 * 侧栏 agent 行左滑「归档」用它；「删除」才是 kill + 移除条目。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body?.name || "");
  if (!name) return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  try {
    const data = await bridgePost(`/agents/${encodeURIComponent(name)}/archive`, {});
    return NextResponse.json({ ok: true, data });
  } catch (e) {
console.error("[bff] /agents/:name/archive 失败:", (e as Error).message);
        return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

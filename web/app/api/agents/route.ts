export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { loadAgents } from "@/lib/chat/agents";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";

/** agent 列表：代理 Bridge GET /api/v1/agents（master 在 token scope 内时置顶入列）。 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const list = await loadAgents();
    return NextResponse.json({ data: list });
  } catch (e) {
    return NextResponse.json(
      { error: `${await st("Bridge 不可达", "Bridge unreachable")}: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

/** 新建 agent：代理 Bridge POST /api/v1/agents（fork additive 端点，内部 runManager create）。 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name, dir, purpose, model, effort } = await request.json().catch(() => ({}));
  if (!name || !dir || typeof name !== "string" || typeof dir !== "string") {
    return NextResponse.json({ error: "name 和 dir 不能为空" }, { status: 400 });
  }
  try {
    // create 会 spawn Claude Code，可能要 10-30s
    const result = await bridgePost(
      "/agents",
      {
        name: name.trim(),
        dir: dir.trim(),
        purpose,
        // 可选钉模型/effort(session 级 CLI flag,不碰全局 settings.json)
        ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
        ...(typeof effort === "string" && effort.trim() ? { effort: effort.trim() } : {}),
      },
      { timeoutMs: 90_000 }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}

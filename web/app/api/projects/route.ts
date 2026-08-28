export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * v2.21+ project 管理(代理 Bridge /api/v1/projects,全权 token)。
 * GET  → {projects:[{id,name,emoji,dirs,description,agents[]}], unassigned[]}
 * POST → {action:"add"|"edit"|"remove"|"assign", id, ...} 委托 manager CLI
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgeGet("/projects"));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await bridgePost("/projects", body));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

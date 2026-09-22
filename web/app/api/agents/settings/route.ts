export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/bff";

/**
 * per-agent 前端配置（当前只有 init_message：clear 后自动发送的开机指令）。
 * 纯用户层数据，存 web 自己的 SQLite——Claudestra 产品侧零感知。
 */

export const GET = withAuth(async (request: Request) => {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return NextResponse.json({ error: "missing agent" }, { status: 400 });
  const row = getDb("settings")
    .prepare("SELECT init_message FROM agent_settings WHERE agent = ?")
    .get(agent) as { init_message: string } | undefined;
  return NextResponse.json({ data: { initMessage: row?.init_message ?? "" } });
});

export const PUT = withAuth(async (request: Request) => {
  const { agent, initMessage } = (await request.json().catch(() => ({}))) as {
    agent?: string;
    initMessage?: string;
  };
  if (!agent || typeof initMessage !== "string") {
    return NextResponse.json({ error: "agent / initMessage 不能为空" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO agent_settings (agent, init_message, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET init_message = excluded.init_message, updated_at = excluded.updated_at`
    )
    .run(agent, initMessage, new Date().toISOString());
  return NextResponse.json({ ok: true });
});

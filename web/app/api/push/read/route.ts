export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";
import { markAgentRead } from "@/lib/push/dispatcher";
import { bridgePost, apiAgentName } from "@/lib/chat/bridge-api";

/**
 * v2.21.1+ 跨端已读对账(owner 2026-08-30「一处点完,他处取消通知」)。
 * POST {agent} → 落库已读时刻 + 向非 iOS 订阅广播 dismiss push + 请 bridge
 *   删掉该 agent 频道里的 Discord 完成 @(清 Discord 侧未读徽标)。
 * GET → {reads: {agent: ts}} —— 打开 App 时的本机补清(iOS 拿不到 dismiss push,
 *   靠它在进入页面时关掉已在别处读过的存量通知)。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { agent?: string };
  const agent = typeof body.agent === "string" ? body.agent.trim().replace(/^agent-/, "") : "";
  if (!agent || !/^[\w一-鿿-]{1,64}$/.test(agent)) {
    return NextResponse.json({ ok: false, error: "agent required" }, { status: 400 });
  }
  markAgentRead(agent);
  // Discord 侧联动:删完成 @ 消息(bridge 记得最近一条的 id)。失败无所谓——
  // 消息可能早被人工清理,或该 agent 根本没 Discord 完成通知。
  void bridgePost(`/agents/${encodeURIComponent(apiAgentName(agent))}/notify-read`, {}).catch(() => {});
  return NextResponse.json({ ok: true });
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const rows = getDb("settings").prepare("SELECT agent, ts FROM push_read").all() as {
      agent: string;
      ts: number;
    }[];
    return NextResponse.json({ ok: true, reads: Object.fromEntries(rows.map((r) => [r.agent, r.ts])) });
  } catch {
    return NextResponse.json({ ok: true, reads: {} });
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/bff";
import { apiAgentName } from "@/lib/chat/bridge-api";
import { hideRange, unhideRange } from "@/lib/chat/hidden";

/**
 * v2.23.1+ 消息删除（= 跨设备隐藏，见 lib/chat/hidden.ts 的语义说明）。
 * POST {agent, session, from, to, hide} —— hide=true 记区间，false 撤销（撤销按 from 定位）。
 */
export const POST = withAuth(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as {
    agent?: string;
    session?: string;
    from?: number;
    to?: number;
    hide?: boolean;
  };
  const agent = typeof body.agent === "string" ? apiAgentName(body.agent.trim()) : "";
  const session = typeof body.session === "string" ? body.session.trim() : "";
  const from = Number(body.from);
  const to = body.to == null ? from : Number(body.to);
  if (!agent || !/^[\w一-鿿-]{1,80}$/.test(agent)) {
    return NextResponse.json({ ok: false, error: "agent required" }, { status: 400 });
  }
  // Pi 会话 id 可以不是 UUID；只挡分隔符/空白，别把合法 id 拒了
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{3,79}$/.test(session)) {
    return NextResponse.json({ ok: false, error: "session required" }, { status: 400 });
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 10_000) {
    return NextResponse.json({ ok: false, error: "bad range" }, { status: 400 });
  }
  try {
    if (body.hide === false) unhideRange(agent, session, from);
    else hideRange(agent, session, from, to);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
});

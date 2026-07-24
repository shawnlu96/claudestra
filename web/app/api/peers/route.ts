export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * HTTP peer 管理（代理 Bridge /api/v1/peers*，全权 token）。
 * GET  → 清单（peers + 入站 scope + 本地 agent 表）
 * POST → {action: invite|join|accept|test|scope|remove, name, ...} 分发
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgeGet("/peers"));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    name?: string;
    agents?: string[];
    url?: string;
    invite?: string;
    receipt?: string;
    force?: boolean;
    rotate?: boolean;
  };
  const { action, name } = body;
  if (!action || !name || typeof name !== "string") {
    return NextResponse.json({ ok: false, error: "action / name 不能为空" }, { status: 400 });
  }
  const enc = encodeURIComponent(name.trim());
  try {
    let result: unknown;
    switch (action) {
      case "invite":
      case "join":
      case "accept":
        result = await bridgePost(`/peers/${action}`, {
          name: name.trim(),
          agents: body.agents,
          url: body.url,
          invite: body.invite,
          receipt: body.receipt,
          force: body.force,
          rotate: body.rotate,
        });
        break;
      case "test":
        result = await bridgePost(`/peers/${enc}/test`, {}, { timeoutMs: 20_000 });
        break;
      case "scope":
        result = await bridgePost(`/peers/${enc}/scope`, { agents: body.agents, force: body.force });
        break;
      case "remove":
        result = await bridgePost(`/peers/${enc}/remove`, {});
        break;
      default:
        return NextResponse.json({ ok: false, error: `未知 action: ${action}` }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (e) {
    // Bridge 的 4xx 语义错误(R1 --force 提示等)也走这里——message 原样透传给 UI
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

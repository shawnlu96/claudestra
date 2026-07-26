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
    id?: string;
  };
  const { action, name } = body;
  if (!action) {
    return NextResponse.json({ ok: false, error: "action 不能为空" }, { status: 400 });
  }
  // v2.15+ 一键邀请系 action 不需要 name（对方名字是兑换时自报的）
  const namelessActions = new Set(["invite-new", "join-auto", "invite-revoke"]);
  const safeName = typeof name === "string" ? name.trim() : "";
  if (!namelessActions.has(action) && !safeName) {
    return NextResponse.json({ ok: false, error: "name 不能为空" }, { status: 400 });
  }
  const enc = encodeURIComponent(safeName);
  try {
    let result: unknown;
    switch (action) {
      case "invite-new":
        result = await bridgePost(`/peers/invite-new`, { agents: body.agents, url: body.url, force: body.force });
        break;
      case "join-auto":
        // 对方 bridge 可能要等 10s 超时才回——给足余量
        result = await bridgePost(`/peers/join-auto`, { invite: body.invite, agents: body.agents, url: body.url, force: body.force }, { timeoutMs: 25_000 });
        break;
      case "invite-revoke":
        result = await bridgePost(`/peers/invite-revoke`, { id: body.id });
        break;
      case "invite":
      case "join":
      case "accept":
        result = await bridgePost(`/peers/${action}`, {
          name: safeName,
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

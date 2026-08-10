export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { getSessionFromCookie } from "@/lib/services/auth.service";
import {
  beginRegistration,
  finishRegistration,
  listCredentials,
  deleteCredential,
  renameCredential,
  deriveRp,
} from "@/lib/services/webauthn.service";

/**
 * Passkey 管理（设置页，需已登录）。登录用的认证流程在 ./login/route.ts —— 那条
 * 必须是未鉴权可达的，两者分开放，避免把未认证入口混进管理端点。
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const rp = deriveRp(request);
  const all = listCredentials();
  return NextResponse.json({
    // supported=false 时前端不展示注册入口（明文 IP 访问等场景）
    supported: !!rp,
    rpID: rp?.rpID ?? null,
    credentials: all.map((c) => ({
      id: c.cred_id,
      name: c.name,
      rpID: c.rp_id,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
      // 当前入口能不能用这条（跨域凭据只展示、不可用）
      usableHere: !!rp && c.rp_id === rp.rpID,
    })),
  });
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    challengeId?: string;
    response?: unknown;
    name?: string;
    id?: string;
  };
  const action = String(body.action || "");

  if (action === "begin") {
    const session = await getSessionFromCookie();
    const r = await beginRegistration(request, session?.username || "claudestra");
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, ...r });
  }

  if (action === "finish") {
    const r = await finishRegistration(
      request,
      String(body.challengeId || ""),
      body.response as never,
      String(body.name || ""),
    );
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  }

  if (action === "delete") {
    if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
    deleteCredential(String(body.id));
    return NextResponse.json({ ok: true });
  }

  if (action === "rename") {
    if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
    renameCredential(String(body.id), String(body.name || ""));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "未知 action" }, { status: 400 });
}

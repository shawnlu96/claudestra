export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";
import { apnsConfigured } from "@/lib/push/apns";
import { startPushDispatcher } from "@/lib/push/dispatcher";

startPushDispatcher();

/**
 * v2.22+ 原生壳的 APNs 设备 token 登记。
 * GET  → { configured, devices }         服务端是否配了 Auth Key、已登记设备数
 * POST { token, device? } → upsert(每次 App 启动都会重新 register,刷新 last_seen)
 * DELETE { token }        → 注销
 */
const TOKEN_RE = /^[0-9a-f]{32,256}$/i;

export async function GET(request: Request) {
  if (!(await isAuthed(request))) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const c = getDb("settings").prepare("SELECT COUNT(*) AS c FROM apns_devices").get() as { c: number };
  return NextResponse.json({ data: { configured: apnsConfigured(), devices: c.c } });
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { token, device } = (await request.json().catch(() => ({}))) as { token?: string; device?: string };
  if (!token || !TOKEN_RE.test(token)) return NextResponse.json({ error: "token 无效" }, { status: 400 });
  const now = new Date().toISOString();
  getDb("settings")
    .prepare(
      `INSERT INTO apns_devices (token, device, created_at, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET device = excluded.device, last_seen = excluded.last_seen`,
    )
    .run(token.toLowerCase(), String(device || "").slice(0, 80), now, now);
  return NextResponse.json({ ok: true, configured: apnsConfigured() });
}

export async function DELETE(request: Request) {
  if (!(await isAuthed(request))) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { token } = (await request.json().catch(() => ({}))) as { token?: string };
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  getDb("settings").prepare("DELETE FROM apns_devices WHERE token = ?").run(token.toLowerCase());
  return NextResponse.json({ ok: true });
}

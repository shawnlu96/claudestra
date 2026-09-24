export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { getSessionFromCookie, sessionCookie } from "@/lib/services/auth.service";

/**
 * 登录成功后的「落盘跳转」：浏览器整页导航到这里，服务器在导航响应里把**同一个**会话 cookie 原样再写一遍，
 * 然后 303 回首页。iOS 原生壳（WKWebView）对 fetch 响应里的 Set-Cookie 落盘不可靠：登录后能用，App
 * 被系统杀掉再冷启动就没了（2026-09-24：壳每次冷启动都要重登，磁盘上只剩更早一次原生表单登录写下的 cookie）。
 * 对普通浏览器只是多一次无害的跳转。没有有效会话 → 回登录页。
 */
export async function GET(request: Request) {
  const session = (await isAuthed(request)) ? await getSessionFromCookie() : undefined;
  if (!session) return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
  const res = new NextResponse(null, { status: 303, headers: { Location: "/" } });
  // 剩余有效期原样带回：不借这次跳转给会话续命
  const leftSec = Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000);
  res.cookies.set(sessionCookie(session.id, Math.max(60, leftSec)));
  return res;
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { getSessionFromCookie, sessionCookie } from "@/lib/services/auth.service";

/**
 * 登录成功后，登录页用**隐藏 iframe** 加载这里：服务器在这次文档导航的响应里把同一个会话 cookie 原样再写一遍。
 * iOS 原生壳（WKWebView）对 fetch 响应里的 Set-Cookie 落盘不可靠：App 被系统杀掉再冷启动 cookie 就没了、
 * 每次都要重登。不用整页跳转：壳会把主框架跳转判成站外、踢去系统浏览器（同 update-toast.tsx 的 hardReload），
 * 子框架导航不走那条判断。只回一张空页，不重定向（iframe 里不该把整个应用再加载一遍）。
 */
export async function GET(request: Request) {
  const session = (await isAuthed(request)) ? await getSessionFromCookie() : undefined;
  const res = new NextResponse("<!doctype html><title>ok</title>", {
    status: session ? 200 : 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
  if (!session) return res;
  // 剩余有效期原样带回：不借这次请求给会话续命
  const leftSec = Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000);
  res.cookies.set(sessionCookie(session.id, Math.max(60, leftSec)));
  return res;
}

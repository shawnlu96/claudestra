import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 proxy（原 middleware，prin-475132）。
 *
 * 只做「页面」的粗门禁：无 cstra_session cookie → 跳 /login。
 * API 不在此拦截——各 API handler 用 isAuthed() 自守（cookie 或 x-api-key）。
 * 原因：① prin-475132 要求需 x-api-key 的 route 在 handler 层自查；
 *       ② proxy 跑在 edge 运行时，读不到 .env.local 的 INTERNAL_API_KEY，
 *          x-api-key 校验放这里会永远失败；handler 跑在 Node 运行时读 env 可靠。
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();

  const sessionCookie = request.cookies.get("cstra_session")?.value;
  if (!sessionCookie) {
    // 登录后回到原页（/join 的邀请码在 # 里，浏览器跟着重定向带过去）
    const next = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(new URL(`/login${next}`, request.url));
  }
  return NextResponse.next();
}

export const config = {
  // 只匹配页面路由；API 由 handler 自守，不经 proxy
  matcher: ["/", "/chat", "/chat/:path*", "/join"],
};

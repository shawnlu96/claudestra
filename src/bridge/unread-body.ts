/**
 * 处理函数没读完请求正文就回了响应（闸门 403、路由 404 之类）时，把剩下的正文读掉再交出响应。
 * Bun 在分块（chunked）正文没读完时，同一条 keep-alive 连接上的下一个请求会直接得到空的 400、处理函数都不会被调用；
 * 反代（tailscale serve、Caddy、本机隧道）的连接池会把别人的请求排在这条连接上。只取消正文不够（实测仍 400），要真读掉。
 * 最多读 64KB；约 1 秒回响应（绝对期限，不随来字节续期），数秒内断开；超限取消并带 Connection: close。
 * 取消不等待底层流完成，否则不结束的上传或 tee 分支仍会拖住响应。tests/unread-body.test.ts。
 */

import { BODY_DEADLINE_MS, readBoundedRequestBody } from "../lib/request-body.js";

/** 最多替处理函数读掉这么多字节；正常的提前拒绝正文都很小 */
const DRAIN_CAP_BYTES = 64 * 1024;

/** 读掉没读的正文；true = 读完了（或本来就没有），false = 超过上限或读失败，这条连接不该再复用 */
export async function drainUnreadBody(req: Request, cap = DRAIN_CAP_BYTES, deadlineMs = BODY_DEADLINE_MS): Promise<boolean> {
  const body = req.body;
  if (!body || req.bodyUsed || body.locked) return true;
  try {
    await readBoundedRequestBody(req, cap, deadlineMs, false);
    return true;
  } catch {
    return false; // 已拒的请求读失败或超限：连接关闭即可，外源滴流不逐条刷日志。
  }
}

/** 包一层 fetch 处理函数：返回响应前把没读的正文读掉，读不完就让响应带 Connection: close（主端口与接管的旧 web 端口共用，bridge.ts） */
export function drainingFetch<S, R extends Response | undefined>(handler: (req: Request, server: S) => Promise<R>) {
  return async (req: Request, server: S): Promise<R> => {
    const res = await handler(req, server);
    if (!res) return res;
    if ((await drainUnreadBody(req)) && res.headers.get("connection")?.toLowerCase() !== "close") return res;
    // Bun 的 socket 超时按粗粒度时钟触发；取消正文后再钉 1 秒 idle，避免沿用长连接 / SSE 的长超时。
    if (server && typeof server === "object" && "timeout" in server && typeof server.timeout === "function") server.timeout(req, 1);
    const headers = new Headers(res.headers); // 转发来的响应头是只读的，复制一份再改
    headers.set("connection", "close");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers }) as R;
  };
}

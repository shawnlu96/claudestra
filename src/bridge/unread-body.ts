/**
 * 处理函数没读完请求正文就回了响应（闸门 403、路由 404 之类）时，把剩下的正文读掉再交出响应。
 * Bun 在分块（chunked）正文没读完时，同一条 keep-alive 连接上的下一个请求会直接得到空的 400、处理函数都不会被调用；
 * 反代（tailscale serve、Caddy、本机隧道）的连接池会把别人的请求排在这条连接上。只取消正文不够（实测仍 400），要真读掉。
 * 读掉有上限（64KB）：超过就取消、响应带 Connection: close 让反代别再复用这条连接（Bun 处理函数里关不了 socket），
 * 免得一个被拒的大上传逼着 bridge 全收下来。tests/unread-body.test.ts。
 */

/** 最多替处理函数读掉这么多字节；正常的提前拒绝正文都很小 */
const DRAIN_CAP_BYTES = 64 * 1024;

/** 读掉没读的正文；true = 读完了（或本来就没有），false = 超过上限或读失败，这条连接不该再复用 */
export async function drainUnreadBody(req: Request, cap = DRAIN_CAP_BYTES): Promise<boolean> {
  const body = req.body;
  if (!body || req.bodyUsed || body.locked) return true;
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      total += value?.byteLength ?? 0;
      if (total > cap) {
        await reader.cancel();
        return false;
      }
    }
  } catch (e) {
    // 客户端中途断开：这条连接本来就不会再复用，没什么可救的
    console.warn(`[bridge] 读掉未读的请求正文失败（${req.method} ${new URL(req.url).pathname}）: ${(e as Error).message}`);
    return false;
  }
}

/** 包一层 fetch 处理函数：返回响应前把没读的正文读掉，读不完就让响应带 Connection: close（主端口与接管的旧 web 端口共用，bridge.ts） */
export function drainingFetch<S, R extends Response | undefined>(handler: (req: Request, server: S) => Promise<R>) {
  return async (req: Request, server: S): Promise<R> => {
    const res = await handler(req, server);
    if (!res || (await drainUnreadBody(req))) return res;
    const headers = new Headers(res.headers); // 转发来的响应头是只读的，复制一份再改
    headers.set("connection", "close");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers }) as R;
  };
}

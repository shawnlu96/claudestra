/**
 * 处理函数没读完请求正文就回了响应（闸门 403、路由 404 之类）时，把剩下的正文读掉再交出响应。
 * Bun 在分块（chunked）正文没读完时，同一条 keep-alive 连接上的下一个请求会直接得到空的 400、处理函数都不会被调用；
 * 反代（tailscale serve、Caddy、本机隧道）的连接池会把别人的请求排在这条连接上。只取消正文不够（实测仍 400），要真读掉。
 * 读掉有上限：超过就放弃（取消），那条连接最多坏掉它自己。tests/unread-body.test.ts。
 */

/** 最多替处理函数读掉这么多字节；正常的提前拒绝正文都很小，大上传被拒时不值得为保连接全收下来 */
const DRAIN_CAP_BYTES = 1 << 20;

export async function drainUnreadBody(req: Request, cap = DRAIN_CAP_BYTES): Promise<void> {
  const body = req.body;
  if (!body || req.bodyUsed || body.locked) return;
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value?.byteLength ?? 0;
      if (total > cap) {
        await reader.cancel();
        return;
      }
    }
  } catch (e) {
    // 客户端中途断开：这条连接本来就不会再复用，没什么可救的
    console.warn(`[bridge] 读掉未读的请求正文失败（${req.method} ${new URL(req.url).pathname}）: ${(e as Error).message}`);
  }
}

/** 包一层 fetch 处理函数：返回响应前把没读的正文读掉（主端口与接管的旧 web 端口共用，bridge.ts） */
export function drainingFetch<S>(handler: (req: Request, server: S) => Promise<Response | undefined>) {
  return async (req: Request, server: S): Promise<Response | undefined> => {
    const res = await handler(req, server);
    await drainUnreadBody(req);
    return res;
  };
}

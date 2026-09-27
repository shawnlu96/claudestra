/**
 * 旧 web 服务的端口由 bridge 接管（lib/legacy-web.ts 的自动迁移写 BRIDGE_LEGACY_WEB_PORT）：手机、tailscale serve、Caddy、
 * 中继子域名隧道原来都指着 `next start` 的 3333，升级后一个都不用改。和旧 web 一样监听所有网卡（局域网 http://<ip>:3333 照旧能开），
 * 请求交给 bridge 主端口同一个处理函数——同一道控制面闸门（非回环只放静态文件与带凭据的 /api/v1，控制路由要 token）；
 * WebSocket 在这里一律不升级（channel-server 只连主端口），省得把 route_to_agent 面带到对外的端口上。
 */
type Handler = (req: Request, server: { requestIP(r: Request): { address: string } | null; upgrade(r: Request): boolean }) => Promise<Response | undefined>;

/** 没配 / 配错端口返回 null；接管成功返回 server（单测用来 stop） */
export function startLegacyWebPort(handler: Handler, env: Record<string, string | undefined> = process.env): { stop(): void } | null {
  const port = Number(env.BRIDGE_LEGACY_WEB_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const hostname = env.BRIDGE_LEGACY_WEB_BIND || "0.0.0.0";
  try {
    const server = Bun.serve({
      port,
      hostname,
      fetch: async (req, server) => {
        if (req.headers.get("upgrade")) return new Response("websocket is not available on the legacy web port", { status: 426 });
        // 处理函数对每个请求都会先试 server.upgrade()；这个 listener 没配 websocket，Bun 会直接抛——升级前面已拒，这里恒为 false
        const view = { requestIP: (r: Request) => server.requestIP(r), upgrade: () => false };
        return (await handler(req, view)) ?? new Response("upgrade refused", { status: 426 });
      },
    });
    console.log(`🌐 旧 web 端口 ${hostname}:${port} 由 bridge 接管（前端静态包 + /api/v1，与主端口同一道闸门）`);
    return server;
  } catch (e) {
    console.error(`⚠️ 旧 web 端口 ${port} 接管失败（多半旧 web 服务还占着：claudestra retire-web）: ${(e as Error).message}`);
    return null;
  }
}

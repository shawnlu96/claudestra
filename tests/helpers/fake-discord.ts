// 本机假 Discord：REST /gateway/bot + gateway ws（HELLO / IDENTIFY→READY / 心跳 ACK；RESUME 一律 INVALID_SESSION 逼重新 identify）。
// 其余 REST 路由回 404 —— 用来验证 ready 之后的 Discord 侧初始化失败时 bridge 也只记日志不退出。
// 用法：tests/discord-login-gateway.test.ts；沙箱桩模式（bridge/config.ts）手动起：
// bun -e 'import("./tests/helpers/fake-discord.ts").then((m) => m.startFakeDiscord(23990, console.log))'

export interface FakeDiscord { server: ReturnType<typeof Bun.serve>; identifies: () => number; restHits: () => string[] }

export function startFakeDiscord(port: number, log: (m: string) => void = () => {}): FakeDiscord {
  let identifies = 0;
  const hits: string[] = [];
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket" && srv.upgrade(req)) return undefined;
      hits.push(`${req.method} ${url.pathname}`);
      if (url.pathname.endsWith("/gateway/bot")) {
        return Response.json({
          url: `ws://127.0.0.1:${port}`, shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        });
      }
      log(`REST ${req.method} ${url.pathname} → 404`);
      return Response.json({ message: "Unknown (fake discord)", code: 0 }, { status: 404 });
    },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })); },
      message(ws, raw) {
        const p = JSON.parse(String(raw)) as { op: number };
        if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
        if (p.op === 6) ws.send(JSON.stringify({ op: 9, d: false }));
        if (p.op !== 2) return;
        identifies++;
        log(`gateway IDENTIFY #${identifies} → READY`);
        ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
          v: 10, user: { id: "100", username: "stub", discriminator: "0", bot: true }, guilds: [],
          session_id: `s${identifies}`, resume_gateway_url: `ws://127.0.0.1:${port}`, application: { id: "100", flags: 0 },
        } }));
      },
    },
  });
  return { server, identifies: () => identifies, restHits: () => hits };
}


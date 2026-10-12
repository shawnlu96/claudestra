// DNF-1 验收 1 / 3：真 discord.js Client + 本机假 Discord（REST /gateway/bot + gateway ws）。
// Discord 先不可达 → connector 退避重试不退出 → 起服务后连上、首次 ready 初始化一次 → 服务断开再恢复，不重复初始化。
import { afterAll, expect, spyOn, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import { bindFirstReady, createDiscordConnector, gatewayConnected } from "../src/bridge/discord-login.ts";

type Srv = ReturnType<typeof Bun.serve>;
let server: Srv | null = null;
let identifies = 0;

function startFakeDiscord(port: number): Srv {
  return Bun.serve({
    port, hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/gateway/bot")) {
        return Response.json({
          url: `ws://127.0.0.1:${port}`, shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        });
      }
      if (req.headers.get("upgrade") === "websocket" && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })); },
      message(ws, raw) {
        const p = JSON.parse(String(raw)) as { op: number };
        if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
        if (p.op === 6) ws.send(JSON.stringify({ op: 9, d: false })); // 不支持 resume：让它重新 identify
        if (p.op === 2) {
          identifies++;
          ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
            v: 10, user: { id: "100", username: "stub", discriminator: "0", bot: true }, guilds: [],
            session_id: `s${identifies}`, resume_gateway_url: `ws://127.0.0.1:${port}`, application: { id: "100", flags: 0 },
          } }));
        }
      },
    },
  });
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await Bun.sleep(20);
  }
}

let client: Client | null = null;
afterAll(async () => { await client?.destroy(); server?.stop(true); });

test("Discord 不可达 → 恢复 → 断开再恢复：进程不退出，首次 ready 初始化只做一次", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never);
  const port = (() => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p; })();
  client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `http://127.0.0.1:${port}/api`, retries: 0, timeout: 2_000 } });
  let inits = 0;
  let readies = 0;
  client.on("ready", () => { readies++; });
  bindFirstReady(client, async () => { inits++; });
  const logs: string[] = [];
  const log = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const c = client;
  const connector = createDiscordConnector({
    login: () => c.login("MTAw.stub.token"), isConnected: () => gatewayConnected(c), log,
    setTimer: (fn) => setTimeout(fn, 30), // 退避压到 30ms，序列本身由 discord-login.test 覆盖
  });

  connector.start();
  await waitFor(() => connector.failures >= 3, 5_000, "连续失败 3 次");
  expect(logs.join("\n")).toContain("📴 Discord 网络不可达");
  expect(inits).toBe(0);

  server = startFakeDiscord(port);
  await waitFor(() => inits === 1 && gatewayConnected(c), 10_000, "恢复后连上");
  expect(connector.failures).toBe(0);
  expect(logs.join("\n")).toContain("✅ Discord 登录恢复");

  // 断开再恢复：shard 自己重连并重新 identify，或看门狗 reconnect 重新 login，都不能重复初始化
  server.stop(true);
  await waitFor(() => !gatewayConnected(c), 5_000, "断开");
  server = startFakeDiscord(port);
  connector.reconnect("测试：模拟看门狗");
  await waitFor(() => gatewayConnected(c) && identifies >= 2, 15_000, "再次连上");
  await Bun.sleep(100);
  expect(inits).toBe(1);
  expect(readies).toBeGreaterThanOrEqual(1);
  expect(exitSpy).not.toHaveBeenCalled();
  exitSpy.mockRestore();
}, 40_000);

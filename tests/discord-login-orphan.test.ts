// DNF-1 r3 P1 gateway-orphan-shard-duplicate-sessions：已连上 → 断网超过 5 分钟 → 恢复，网关会话必须只有 1 个。
// 旧实现每次重连都调 client.login()：@discordjs/ws 销毁旧 shard 时，正在 500ms 空闲里等自重连的 shard 销毁不掉，
// 移出 map 后还在后台重连，恢复后各自 IDENTIFY → 同一次按钮点击被处理 N 次。接线与 src/bridge.ts 相同。
import { afterAll, expect, spyOn, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import { createDiscordConnector, createStatusWatchdog, gatewayConnected, LOGIN_TIMEOUT_MS } from "../src/bridge/discord-login.ts";
import { createShardReaper } from "../src/bridge/discord-login-shards.ts";
import { startFakeDiscord, type FakeDiscord } from "./helpers/fake-discord.ts";

let fake: FakeDiscord | null = null;
let client: Client | null = null;
afterAll(async () => { await client?.destroy(); fake?.server.stop(true); });

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await Bun.sleep(20);
  }
}

test("已连上 → 断网超过 5 分钟 → 恢复：只有 1 个网关会话，一次按钮点击只触发 1 次 interactionCreate", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const port = (() => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; })();
  fake = startFakeDiscord(port, () => {}, 3_600_000); // gateway 信息像真 Discord 一样被缓存：断网期间 login() 能走到 spawn shard
  const reaper = createShardReaper();
  client = new Client({
    intents: [GatewayIntentBits.Guilds], ws: { buildStrategy: reaper.buildStrategy },
    rest: { api: `http://127.0.0.1:${port}/api`, retries: 0, timeout: 2_000 },
  });
  const c = client;
  let clicks = 0;
  c.on("interactionCreate", () => { clicks++; });
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const connector = createDiscordConnector({
    login: () => reaper.guard(c.login("MTAw.stub.token")), isConnected: () => gatewayConnected(c), log: quiet,
    setTimer: (fn, ms) => setTimeout(fn, ms === LOGIN_TIMEOUT_MS ? ms : 50), // 只压退避：断网几小时里的几十次重试压成几秒
  });
  const watchdogTick = createStatusWatchdog(() => gatewayConnected(c), connector);

  connector.start();
  await waitFor(() => gatewayConnected(c), 10_000, "首次连上");
  fake.clickButton("1");
  await waitFor(() => clicks === 1, 5_000, "断网前点击");

  fake.setDown(true);
  await waitFor(() => !gatewayConnected(c), 5_000, "断网");
  for (let i = 0; i < 5; i++) watchdogTick(); // 假时钟：看门狗每分钟一拍，5 拍不在线 = 断网 5 分钟 → reconnect
  await waitFor(() => connector.failures >= 8, 20_000, "断网期间多次重试");

  fake.setDown(false);
  await waitFor(() => gatewayConnected(c), 15_000, "恢复后连上");
  await Bun.sleep(12_000); // 孤儿 shard 的 IDENTIFY 被 discord.js 限流成每 5s 一个：等两轮以上
  expect(fake.sessions()).toBe(1);
  clicks = 0;
  fake.clickButton("2");
  await Bun.sleep(500);
  expect(clicks).toBe(1);
  warn.mockRestore();
}, 60_000);

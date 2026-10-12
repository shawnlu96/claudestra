// DNF-1 验收 1 / 3：真 discord.js Client + 本机假 Discord（REST /gateway/bot + gateway ws）。
// Discord 先不可达 → connector 退避重试不退出 → 起服务后连上、首次 ready 初始化一次 → 服务断开再恢复，不重复初始化。
import { afterAll, expect, spyOn, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import { bindFirstReady, createDiscordConnector, gatewayConnected, LOGIN_TIMEOUT_MS } from "../src/bridge/discord-login.ts";
import { startFakeDiscord, type FakeDiscord } from "./helpers/fake-discord.ts";

let fake: FakeDiscord | null = null;
const identifies = () => fake?.identifies() ?? 0;

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await Bun.sleep(20);
  }
}

let client: Client | null = null;
afterAll(async () => { await client?.destroy(); fake?.server.stop(true); });

test("Discord 不可达 → 恢复 → 断开再恢复：进程不退出，首次 ready 初始化只做一次", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never);
  const port = (() => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; })();
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
    setTimer: (fn, ms) => setTimeout(fn, ms === LOGIN_TIMEOUT_MS ? ms : 30), // 只压退避（序列由 discord-login.test 覆盖），登录超时保持原值
  });

  connector.start();
  await waitFor(() => connector.failures >= 3, 5_000, "连续失败 3 次");
  expect(logs.join("\n")).toContain("📴 Discord 网络不可达");
  expect(inits).toBe(0);

  fake = startFakeDiscord(port);
  await waitFor(() => inits === 1 && gatewayConnected(c), 10_000, "恢复后连上");
  expect(connector.failures).toBe(0);
  expect(logs.join("\n")).toContain("✅ Discord 登录恢复");

  // 断开再恢复：shard 自己重连并重新 identify，或看门狗 reconnect 重新 login，都不能重复初始化
  fake.server.stop(true);
  await waitFor(() => !gatewayConnected(c), 5_000, "断开");
  fake = startFakeDiscord(port);
  connector.reconnect("测试：模拟看门狗");
  await waitFor(() => gatewayConnected(c) && identifies() >= 1, 15_000, "再次连上（新实例收到 identify）");
  await Bun.sleep(100);
  expect(inits).toBe(1);
  expect(readies).toBeGreaterThanOrEqual(1);
  expect(exitSpy).not.toHaveBeenCalled();
  exitSpy.mockRestore();
}, 40_000);

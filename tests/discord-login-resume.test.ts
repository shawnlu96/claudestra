// DNF-2 resume-gateway-egress：桩在 READY 里下发异源 resume_gateway_url 时，断线恢复不能连到桩以外。
// @discordjs/ws 恢复时直接用 READY 给的地址建 WebSocket（装闸前就抓住了构造器），只核对 /gateway/bot 不够。
// 接线与 src/bridge.ts 桩模式相同：stubRestOptions + createShardReaper。
import { afterAll, expect, spyOn, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import { gatewayConnected } from "../src/bridge/discord-login.ts";
import { createShardReaper } from "../src/bridge/discord-login-shards.ts";
import { stubRestOptions } from "../src/bridge/discord-login-stub.ts";
import { startFakeDiscord, type FakeDiscord } from "./helpers/fake-discord.ts";

const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };

let fake: FakeDiscord | null = null;
let evil: ReturnType<typeof Bun.serve> | null = null;
let client: Client | null = null;
afterAll(async () => { await client?.destroy(); fake?.server.stop(true); evil?.stop(true); });

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await Bun.sleep(20);
  }
}

test("桩下发异源 resume_gateway_url：恢复只走桩同源，禁用端口 0 次命中", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let evilHits = 0;
  evil = Bun.serve({ port: freePort(), hostname: "127.0.0.1", fetch: () => { evilHits++; return new Response("no", { status: 503 }); } });
  const port = freePort();
  fake = startFakeDiscord(port, () => {}, 0, { resumeUrl: `ws://127.0.0.1:${evil.port}` });
  const reaper = createShardReaper();
  client = new Client({
    intents: [GatewayIntentBits.Guilds], ws: { buildStrategy: reaper.buildStrategy },
    rest: { ...stubRestOptions(`http://127.0.0.1:${port}/api`), retries: 0, timeout: 2_000 },
  });
  const c = client;
  await reaper.guard(c.login("MTAw.stub.token"));
  await waitFor(() => gatewayConnected(c), 10_000, "首次连上");

  fake.kick(4000); // UnknownError → discord.js 按 RESUME 恢复，连 READY 给的 resume 地址
  await waitFor(() => fake!.resumes() >= 1 || evilHits > 0, 10_000, "恢复发起（打到桩或禁用端口）");
  expect(evilHits).toBe(0);
  expect(fake.resumes()).toBe(1);
  await waitFor(() => gatewayConnected(c), 10_000, "恢复后连上");
  expect(evilHits).toBe(0);
  expect(warn.mock.calls.some(([m]) => String(m).includes("拒绝异源恢复地址"))).toBe(true);
  warn.mockRestore();
}, 30_000);

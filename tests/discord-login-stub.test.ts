// DNF-1 验收追加（P1 sandbox-discord-rest-port-bypass）：沙箱 Discord 桩的 REST 目标端口必须是授权给沙箱自己的端口。
// discord.js 的 REST 走 Bun 内置 undici，沙箱出站闸拦不到 —— 所以端口只能在建 client 之前由 config 核对，不过就拒绝启动。
// 子进程按 bridge 的方式加载 bridge/config.ts，拿它给出的 DISCORD_REST_API 发一次 rest.post，数接收端收到几个请求。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { testChildEnv } from "./test-env.ts";

const REPO = resolve(import.meta.dir, "..");
const CONFIG = JSON.stringify(join(REPO, "src/bridge/config.ts"));
let tmp = "";
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "dnf-stub-")); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 一次性接收端：记下收到的请求数 */
function receiver() {
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return Response.json({}); } });
  return { port: server.port!, hits: () => hits, stop: () => server.stop(true) };
}

async function loadAndPost(bridgePort: number, apiPort: number, deny: string): Promise<{ out: string; err: string }> {
  const code = `
    const { REST } = await import("discord.js"); // 与 bridge.ts 同序：discord.js 先于 config（装闸）求值
    const c = await import(${CONFIG});
    await new REST({ api: c.DISCORD_REST_API, retries: 0, timeout: 2000 }).setToken(c.DISCORD_TOKEN).post("/probe").catch(() => {});
    console.log("posted");`;
  const root = mkdtempSync(join(tmp, "sbx-"));
  const env = testChildEnv({
    HOME: join(root, "home"), CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: root,
    CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"),
    BRIDGE_PORT: String(bridgePort), BRIDGE_URL: `ws://127.0.0.1:${bridgePort}`, CLAUDESTRA_SANDBOX_DENY_PORTS: deny,
    CLAUDESTRA_SANDBOX_DISCORD_STUB: "1", CLAUDESTRA_SANDBOX_DISCORD_API: `http://127.0.0.1:${apiPort}/api`,
  });
  const p = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { cwd: REPO, stdout: "pipe", stderr: "pipe", env });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { out, err };
}

test("① 桩 REST 指向生产禁用端口：config 拒绝加载，禁用端口的接收端收到 0 个请求", async () => {
  const r = receiver();
  try {
    const res = await loadAndPost(r.port - 10, r.port, `3848,${r.port}`);
    expect(r.hits()).toBe(0);
    expect(res.out).not.toContain("posted");
    expect(res.err).toContain("CLAUDESTRA_SANDBOX_DISCORD_API");
  } finally { r.stop(); }
}, 30_000);

test("① 桩 REST 指向不属于本沙箱的端口（不是 BRIDGE_PORT+10）：同样拒绝，0 个请求", async () => {
  const r = receiver();
  try {
    const res = await loadAndPost(r.port - 3, r.port, "3848");
    expect(r.hits()).toBe(0);
    expect(res.out).not.toContain("posted");
  } finally { r.stop(); }
}, 30_000);

test("② 合法桩目标（BRIDGE_PORT+10，不在禁用列表）：正常收到请求", async () => {
  const r = receiver();
  try {
    const res = await loadAndPost(r.port - 10, r.port, "3848");
    expect(res.err).toBe("");
    expect(res.out).toContain("posted");
    expect(r.hits()).toBe(1);
  } finally { r.stop(); }
}, 30_000);

test("sandboxDiscordStubApi：边界一律拒绝；没开桩 / 不在沙箱返回 undefined", async () => {
  const { sandboxDiscordStubApi } = await import("../src/bridge/discord-login-stub.ts");
  const base = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_DISCORD_STUB: "1", BRIDGE_PORT: "23900" };
  const api = (v: string | undefined, extra: Record<string, string> = {}) => () => sandboxDiscordStubApi({ ...base, CLAUDESTRA_SANDBOX_DISCORD_API: v, ...extra }, 3847);
  expect(api("http://127.0.0.1:23910/api")()).toBe("http://127.0.0.1:23910/api");
  for (const bad of [undefined, "not a url", "https://127.0.0.1:23910/api", "http://10.0.0.5:23910/api", "http://127.0.0.1:23911/api", "http://127.0.0.1/api"]) {
    expect(api(bad)).toThrow("拒绝启动");
  }
  expect(api("http://127.0.0.1:3847/api", { BRIDGE_PORT: "3837" })).toThrow("生产端口");
  expect(api("http://127.0.0.1:23910/api", { BRIDGE_PORT: "" })).toThrow("桩端口");
  expect(sandboxDiscordStubApi({ CLAUDESTRA_SANDBOX: "1" }, 3847)).toBeUndefined();
  expect(sandboxDiscordStubApi({ CLAUDESTRA_SANDBOX_DISCORD_STUB: "1", CLAUDESTRA_SANDBOX_DISCORD_API: "http://127.0.0.1:1/api" }, 3847)).toBeUndefined();
});

/**
 * 挂载闸看的是模型实际拿到的工具表，不是「配置写进去了」：2026-10-01 mm-docs 迁 ACP，用户全局装的 pi-mcp-adapter 注册了 /mcp，
 * pi 于是不加载 builtin:mcp，registerMcpServer 挂的 channel-server 没人连，模型调 reply 得到「Tool reply not found」，挂载扩展却照报 ok。
 * 现在：连接走挂载扩展自带的连接器（不靠 builtin:mcp），session_start 等到 reply 真进了工具表才报 ok，等不到就报原因、适配器拒会话。
 * 最后一组用本机真 pi（没装或低于 0.99 跳过）：临时目录里放一个注册 /mcp 的假第三方扩展，复现 builtin:mcp 被顶掉，核对照样挂得上。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piRpcArgs } from "../src/lib/acp/pi-adapter/args.ts";
import mountMcpServers, { MOUNT_OK, MOUNT_STATUS_KEY, PI_MCP_SERVERS_ENV, type MountApi } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { piBinName } from "../src/lib/pi-env.ts";
import { testChildEnv } from "./test-env.ts";

type Handler = Parameters<MountApi["on"]>[1];
const REPLY = "mcp__claudestra__reply";
const root = mkdtempSync(join(tmpdir(), "pi-acp-mount-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 假 pi：按注册顺序收 session_start handler，start() 像 pi 一样逐个 await；工具表由 tools 决定 */
function fakePi(tools: () => string[]) {
  const handlers: Handler[] = [];
  const statuses: string[] = [];
  const ctx = { cwd: join(root, "work"), ui: { setStatus: (k: string, t: string | undefined) => void (k === MOUNT_STATUS_KEY && statuses.push(String(t))) } };
  const api = { on: (e: string, h: Handler) => void (e === "session_start" && handlers.push(h)), getActiveTools: tools };
  const start = async () => {
    for (const h of handlers) await h({}, ctx);
  };
  return { api, start, statuses };
}

const envWith = (servers: Record<string, unknown>) => ({ [PI_MCP_SERVERS_ENV]: JSON.stringify(servers), PI_CODING_AGENT_DIR: join(root, "agent") });
const SERVERS = { claudestra: { command: "x" } };

describe("挂载闸：认工具表", () => {
  test("谁也没连上（如 builtin:mcp 被注册 /mcp 的第三方扩展顶掉），工具表里一直没有 reply：报原因、不报 ok", async () => {
    const pi = fakePi(() => ["read", "bash", "mcp", "mcpScript"]);
    await mountMcpServers(pi.api, envWith(SERVERS), async () => {}, 50);
    await pi.start();
    expect(pi.statuses).toEqual([expect.stringContaining(REPLY)]);
  });

  test("连接是异步的：连接器的 session_start 先跑、开始连，闸门等到 reply 进了工具表才报 ok", async () => {
    let connected = false;
    const pi = fakePi(() => (connected ? ["read", REPLY] : ["read"]));
    const connect = async (api: MountApi) => void api.on("session_start", () => void setTimeout(() => (connected = true), 30));
    await mountMcpServers(pi.api, envWith(SERVERS), connect, 2_000);
    await pi.start();
    expect(pi.statuses).toEqual([MOUNT_OK]);
  });

  test("没挂 channel-server（只挂别的 server）不等 reply；撞名照旧先拒", async () => {
    const other = fakePi(() => []);
    await mountMcpServers(other.api, envWith({ other: { command: "x" } }), async () => {}, 50);
    await other.start();
    expect(other.statuses).toEqual([MOUNT_OK]);

    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "mcp.json"), JSON.stringify({ mcpServers: { claudestra: { command: "evil" } } }));
    const clash = fakePi(() => [REPLY]);
    await mountMcpServers(clash.api, envWith(SERVERS), async () => {}, 50);
    await clash.start();
    rmSync(join(root, "agent", "mcp.json"));
    expect(clash.statuses).toEqual([expect.stringContaining("顶掉")]);
  });
});

const piVersion = (() => {
  // 没装 pi 时 spawnSync 直接抛 ENOENT（不是返回非零），不接住整个文件在 import 阶段就挂（CI 没有 pi）
  try {
    const r = Bun.spawnSync([piBinName(), "--version"], { env: testChildEnv({ PI_OFFLINE: "1" }) });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
})();
const realPi = /^0\.(99|\d{3,})\.|^[1-9]\d*\./.test(piVersion);

/** 最小 stdio MCP server：只有 reply 一个工具；每个请求的 method 记一行 */
const FAKE_MCP = `import { appendFileSync } from "node:fs";
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\\n")) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    appendFileSync(process.argv[2], m.method + "\\n");
    if (m.id === undefined) continue;
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "reply", inputSchema: { type: "object" } }] } });
    else out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;

describe.skipIf(!realPi)(`真 pi ${piVersion}：第三方扩展注册了 /mcp（builtin:mcp 不加载）`, () => {
  test("channel-server 照样挂上，reply 进了工具表才报 ok", async () => {
    const dir = join(root, "real");
    mkdirSync(join(dir, "agent"), { recursive: true });
    mkdirSync(join(dir, "home"));
    mkdirSync(join(dir, "work"));
    writeFileSync(join(dir, "third-party-mcp.ts"), `export default (pi) => pi.registerCommand("mcp", { description: "third-party", handler: async () => {} });\n`);
    writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ extensions: [join(dir, "third-party-mcp.ts")] }));
    writeFileSync(join(dir, "mcp.mjs"), FAKE_MCP);
    const requests = join(dir, "requests.log");
    writeFileSync(requests, "");
    const servers = { claudestra: { command: process.execPath, args: [join(dir, "mcp.mjs"), requests], env: {} } };
    const env = testChildEnv({ HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", [PI_MCP_SERVERS_ENV]: JSON.stringify(servers) });
    const pi = Bun.spawn([piBinName(), ...piRpcArgs(crypto.randomUUID())], { cwd: join(dir, "work"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      let status: string | undefined;
      let buf = "";
      for await (const chunk of pi.stdout) {
        buf += new TextDecoder().decode(chunk);
        const hit = buf.split("\n").map((l) => (l.startsWith("{") ? JSON.parse(l) : {})).find((r) => r.statusKey === MOUNT_STATUS_KEY);
        if (hit) {
          status = hit.statusText;
          break;
        }
      }
      pi.stdin.end();
      const stderr = await new Response(pi.stderr).text();
      expect(stderr).toContain("built-in extension `mcp` was not loaded"); // 场景确实复现了
      expect(status).toBe(MOUNT_OK);
      expect(readFileSync(requests, "utf8")).toContain("tools/list");
    } finally {
      pi.kill();
    }
  }, 40_000);
});

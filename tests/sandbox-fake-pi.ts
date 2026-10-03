/**
 * tests/sandbox-isolation.test.ts 用的「假 pi」（`pi --mode rpc` 那一面）：ACP 适配器起它时，照真 pi 那样
 * 按 CLAUDESTRA_PI_MCP_SERVERS 拉起 channel-server 并握手（值按 pi 的模板规则反转义）、在 PI_CODING_AGENT_DIR 下写会话文件、
 * 答适配器开会话时的三问；收到 prompt 就像模型那样取 <channel> 头里的 chat_id 调 mcp__claudestra__reply 回 pong，再按 agent_settled 收尾。
 * 每次启动把 argv 和要核对的环境变量记一行 JSON，给断言看 Pi 链上的目录、HOME、发现开关是不是沙箱里的那一套。
 * 也像真 pi 那样加载本仓的挂载扩展、在读命令前跑它的 session_start（它报撞名状态，适配器没收到 OK 就拒会话）。
 */
import { MCP_MOUNT_EXTENSION } from "../src/lib/acp/pi-adapter/args.ts";

export function fakePiSource(bunPath: string, logPath: string): string {
  return `#!${bunPath}
import { appendFileSync, mkdirSync, openSync, writeFileSync } from "fs";
import { join } from "path";
const LOG = ${JSON.stringify(logPath)};
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + "\\n");
const argv = process.argv.slice(2);
const sid = argv[argv.indexOf("--session-id") + 1];
const env = process.env;
log({ argv, HOME: env.HOME, PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR, PI_OFFLINE: env.PI_OFFLINE, BRIDGE_PORT: env.BRIDGE_PORT ?? null,
  DISCORD_CHANNEL_ID: env.DISCORD_CHANNEL_ID ?? null, mcp: Object.keys(JSON.parse(env.CLAUDESTRA_PI_MCP_SERVERS ?? "{}")) });
const sessions = join(env.PI_CODING_AGENT_DIR, "sessions", "--fake--");
mkdirSync(sessions, { recursive: true });
writeFileSync(join(sessions, "2026-10-01T00-00-00-000Z_" + sid + ".jsonl"), JSON.stringify({ type: "session", version: 3, id: sid, cwd: process.cwd() }) + "\\n");
const srv = Object.values(JSON.parse(env.CLAUDESTRA_PI_MCP_SERVERS ?? "{}"))[0];
const literal = (v) => v.replace(/^\\$!/, "!").replace(/\\$\\$/g, "$");
const child = Bun.spawn([srv.command, ...srv.args], { stdin: "pipe", stdout: "pipe", stderr: openSync(LOG + ".mcp-stderr", "a"),
  env: { ...env, ...Object.fromEntries(Object.entries(srv.env ?? {}).map(([k, v]) => [k, literal(v)])) } });
const mcpWaiters = new Map();
let mcpId = 1;
const mcp = (method, params) => new Promise((resolve) => {
  const id = mcpId++;
  mcpWaiters.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  child.stdin.flush();
});
const out = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
const ui = { setStatus: (k, t) => out({ type: "extension_ui_request", id: "st", method: "setStatus", statusKey: k, statusText: t }) };
let started;
const piApi = { on: (_e, h) => void (started = h({}, { cwd: process.cwd(), ui })), getActiveTools: () => ["mcp__claudestra__reply"] };
await (await import(${JSON.stringify(MCP_MOUNT_EXTENSION)})).default(piApi, process.env, async () => {});
await started;
(async () => {
  let buf = "";
  for await (const chunk of child.stdout) {
    buf += new TextDecoder().decode(chunk);
    for (let nl; (nl = buf.indexOf("\\n")) >= 0;) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (m.id && mcpWaiters.has(m.id)) mcpWaiters.get(m.id)(m.result ?? m.error), mcpWaiters.delete(m.id);
    }
  }
})();
const ready = mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-pi", version: "0" } }).then(() => {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  log({ mcp: "initialized" });
});
const DATA = {
  get_state: { model: { provider: "fake", id: "m", name: "M" }, thinkingLevel: "off" },
  get_available_models: { models: [{ provider: "fake", id: "m", name: "M" }] },
  get_available_thinking_levels: { levels: ["off"] },
  get_session_stats: { contextUsage: { tokens: 10, contextWindow: 1000 } },
};
async function turn(message) {
  await ready;
  const args = { chat_id: /chat_id="([^"]+)"/.exec(message)?.[1], text: "pong" };
  out({ type: "agent_start" });
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "mcp__claudestra__reply", args });
  const result = await mcp("tools/call", { name: "reply", arguments: args });
  log({ reply: result });
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "mcp__claudestra__reply", result, isError: false });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_settled" });
}
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\\n")) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const data = m.type === "prompt" ? { disposition: "started" } : DATA[m.type] ?? {};
    out({ id: m.id, type: "response", command: m.type, success: true, data });
    if (m.type === "prompt") void turn(m.message);
  }
});
process.stdin.on("end", () => { child.kill(); process.exit(0); });
`;
}

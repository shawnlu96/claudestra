/**
 * 宿主整条链换成 Pi：真的 AcpHost（runtime=pi）+ 真的 Pi 适配器进程（bun main.ts）+ 假 pi（临时目录里的可执行文件，PI_BIN 指过去）
 * + 真的回环代理；bridge 与 /hook 是假的。钉住 PR1a 留的几件事：channel-server 经 mcpServers 交给 pi（/clear 新会话再交一次），
 * 回环代理 token 只在挂载那一份配置里；宿主按 pi 登记；/clear 不跑引导轮；registry 的裸模型 id 对上 provider/id；同名 MCP 拒起且出卡。
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { acpRuntime } from "../src/lib/acp/host-runtime.ts";
import { PI_ACP_ADAPTER_MAIN } from "../src/lib/acp/pi-adapter/main.ts";
import { MCP_MOUNT_EXTENSION } from "../src/lib/acp/pi-adapter/args.ts";
import { PI_MCP_SERVERS_ENV } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..");
const SID = "019a0000-0000-7000-8000-0000000000aa";
const root = mkdtempSync(join(tmpdir(), "pi-acp-host-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// 假 pi：启动时记 argv 和带 token 的环境变量名，再像真 pi 一样加载本仓的挂载扩展、在读命令前跑它的 session_start（报撞名状态）；
// 每条命令记一笔；prompt 后吐一个最小回合（agent_start → 正文 → agent_settled）；FAKE_PI_EXIT_WRITE=文件<TAB>内容：退出前写一份文件
const FAKE_PI = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const log = (o) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ pid: process.pid, ...o }) + "\\n");
const mountUrl = JSON.parse(process.env.${PI_MCP_SERVERS_ENV} || "{}").claudestra?.env?.BRIDGE_URL ?? "";
const token = new URL(mountUrl || "ws://x").searchParams.get("t");
const tokenVars = token ? Object.entries(process.env).filter(([, v]) => String(v).includes(token)).map(([k]) => k) : [];
log({ argv: process.argv.slice(2), mcp: process.env.${PI_MCP_SERVERS_ENV} ?? null, tokenVars, bridgeUrl: process.env.BRIDGE_URL ?? null });
const models = [{ provider: "ds", id: "v4", name: "V4" }, { provider: "ds", id: "flash", name: "Flash" }];
let model = models[0];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ui = { setStatus: (k, t) => out({ type: "extension_ui_request", id: "st", method: "setStatus", statusKey: k, statusText: t }) };
let started;
const piApi = { on: (_e, h) => void (started = h({}, { cwd: process.cwd(), ui })), getActiveTools: () => ["mcp__claudestra__reply"] };
await (await import(${JSON.stringify(MCP_MOUNT_EXTENSION)})).default(piApi, process.env, async () => {});
await started;
const ok = (m, data = {}) => out({ id: m.id, type: "response", command: m.type, success: true, data });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ cmd: m.type, ...(m.type === "set_model" ? { provider: m.provider, modelId: m.modelId } : {}), ...(m.type === "prompt" ? { message: m.message } : {}) });
    if (m.type === "get_state") ok(m, { model, thinkingLevel: "off" });
    else if (m.type === "get_available_models") ok(m, { models });
    else if (m.type === "get_available_thinking_levels") ok(m, { levels: ["off"] });
    else if (m.type === "set_model") (model = models.find((x) => x.id === m.modelId) ?? model), ok(m, model);
    else if (m.type === "prompt") {
      ok(m);
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant" } });
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到" } });
      out({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到" }] } });
      out({ type: "agent_settled" });
    } else ok(m);
  }
});
process.stdin.on("end", async () => {
  const [file, body] = (process.env.FAKE_PI_EXIT_WRITE || "").split("\\t");
  if (file) (await import("node:fs")).writeFileSync(file, body);
  process.exit(0);
});
`;

const until = async (cond: () => boolean, what: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

let host: AcpHost | null = null;
const procs: AdapterProc[] = [];
afterEach(() => {
  host?.stop();
  host = null;
  for (const p of procs.splice(0)) p.stop();
});

function start(name: string, extraEnv: Record<string, string> = {}) {
  const dir = join(root, name);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const fake = join(dir, "pi");
  writeFileSync(fake, FAKE_PI);
  chmodSync(fake, 0o755);
  const logFile = join(dir, "pi.log");
  const sent: any[] = [];
  const logs: string[] = [];
  const rotations: [string, string][] = [];
  const stops: any[] = [];
  let link!: Omit<BridgeLinkDeps, "url">;
  let ready = false;
  const base = testChildEnv({ PI_BIN: fake, FAKE_PI_LOG: logFile, PI_CODING_AGENT_DIR: agentDir, ...extraEnv });
  host = new AcpHost(
    {
      channelId: `local-pi-acp-${name}`, agentName: "agent-pi-acp", sessionId: SID, cwd: dir, mcpName: "claudestra", model: "flash",
      agentCmd: [process.execPath, PI_ACP_ADAPTER_MAIN, "--approve"], runtime: acpRuntime("pi"),
      env: { base, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: dir },
    },
    {
      spawn: (cmd, env, cwd) => {
        const p = spawnAdapter(cmd, env, cwd, (m) => logs.push(m), "pi-acp");
        procs.push(p);
        return p;
      },
      makeLink: (d) => {
        link = d;
        return {
          connect: () => void setTimeout(() => d.onRegistered(), 0),
          send: (f: any) => (sent.push(f), true),
          request: async (f: any) => (f.type === "acp_rebind" || f.type === "acp_entries" ? true : null),
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async (oldId, newId) => (rotations.push([oldId, newId]), { ok: true }),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  const pi = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const runs = () => pi().filter((r) => r.argv);
  const cmds = (pid: number) => pi().filter((r) => r.pid === pid && r.cmd);
  return { dir, agentDir, sent, logs, rotations, stops, pi, runs, cmds, link: () => link, isReady: () => ready, frame: (m: any) => link.onFrame(m) };
}

test("channel-server 经 mcpServers 交给 pi，token 只在挂载配置里；宿主按 pi 登记；裸模型 id 对上 provider/id；回合照常收尾", async () => {
  const h = start("main");
  await until(h.isReady, "宿主就绪");
  expect(h.link().registerFrame()).toMatchObject({ runtime: "pi", transport: "acp", sessionId: SID });

  const [run] = h.runs();
  expect(run.argv).toEqual(["--mode", "rpc", "--approve", "-e", "builtin:mcp", "-e", expect.stringContaining("mcp-mount.ts"), "--session-id", SID]);
  const mounted = JSON.parse(run.mcp).claudestra;
  expect(mounted.command).toBe(process.execPath);
  expect(mounted.args).toEqual([join(REPO, "src/channel-server.ts")]);
  expect(mounted.env).toMatchObject({ DISCORD_CHANNEL_ID: "local-pi-acp-main", CLAUDESTRA_RUNTIME: "pi", CLAUDESTRA_SESSION_ID: SID, MCP_NAME: "claudestra" });
  expect(mounted.env.BRIDGE_URL).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{16,}$/);
  expect(run.tokenVars).toEqual([PI_MCP_SERVERS_ENV]); // 挂载扩展读完就删（mcp-mount.ts），pi 的 bash 子进程拿不到
  expect(run.bridgeUrl).toBeNull(); // 宿主环境里的 bridge 地址（testChildEnv 的死端口）也不往下传
  expect(h.cmds(run.pid).find((c) => c.cmd === "set_model")).toEqual(expect.objectContaining({ provider: "ds", modelId: "flash" }));

  h.frame({ type: "message", content: "在吗", meta: { chat_id: "api:owner", message_id: "m1" } });
  await until(() => h.stops.length === 1, "第一回合报 Stop");
  expect(h.stops[0]).toMatchObject({ channelId: "local-pi-acp-main" });
  const prompt = h.cmds(run.pid).find((c) => c.cmd === "prompt")!.message;
  expect(prompt).toContain('<channel source="claudestra"');
  expect(prompt).toContain("mcp__claudestra__reply");
}, 30_000);

test("/clear：适配器换新 pi、新会话再带一次 mcpServers；不跑 Codex 的引导轮；registry 轮转到新 id，模型照 registry 补上", async () => {
  const h = start("clear");
  await until(h.isReady, "宿主就绪");
  h.frame({ type: "acp_call", id: "c1", op: "clear" });
  await until(() => h.sent.some((f) => f.id === "c1"), "clear 回包");
  const result = h.sent.find((f) => f.id === "c1");
  expect(result).toMatchObject({ ok: true });
  expect(h.rotations).toEqual([[SID, result.sessionId]]);
  const runs = h.runs();
  expect(runs).toHaveLength(2);
  expect(runs[1].argv.at(-1)).toBe(result.sessionId);
  expect(JSON.parse(runs[1].mcp).claudestra.env.BRIDGE_URL).toMatch(/\?t=[0-9a-f]{16,}$/);
  expect(runs[1].tokenVars).toEqual([PI_MCP_SERVERS_ENV]);
  const fresh = h.cmds(runs[1].pid).map((c) => c.cmd);
  expect(fresh).not.toContain("prompt");
  expect(fresh).toContain("set_model");
}, 30_000);

test("钉住：pi 的 mcp.json 里有同名 claudestra → 适配器拒起这个会话，宿主出失败卡、不标就绪，假 pi 一次都没起", async () => {
  const dir = join(root, "clash");
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "mcp.json"), JSON.stringify({ mcpServers: { claudestra: { command: "evil" } } }));
  const h = start("clash");
  await until(() => h.sent.some((f) => f.type === "acp_failure"), "失败卡");
  const failure = h.sent.find((f) => f.type === "acp_failure");
  expect(failure.failure.message).toContain("顶掉");
  expect(failure.label).toBe("Pi");
  expect(h.isReady()).toBe(false);
  expect(h.runs()).toEqual([]);
}, 30_000);

test("/clear 时旧 pi 退出前写进同名配置：/clear 失败、registry 不换代、新 pi 不起；宿主重起适配器接回旧会话，被同一道闸拒并出卡", async () => {
  const clash = JSON.stringify({ mcpServers: { claudestra: { command: "evil", exposure: "hidden" } } });
  const h = start("clear-race", { FAKE_PI_EXIT_WRITE: `${join(root, "clear-race", "agent", "mcp.json")}\t${clash}` });
  await until(h.isReady, "宿主就绪");
  h.frame({ type: "acp_call", id: "c1", op: "clear" });
  await until(() => h.sent.some((f) => f.id === "c1"), "clear 回包");
  expect(h.sent.find((f) => f.id === "c1")).toMatchObject({ ok: false, error: expect.stringContaining("顶掉") });
  expect(h.rotations).toEqual([]);
  expect(h.runs()).toHaveLength(1);
  await until(() => h.sent.some((f) => f.type === "acp_failure" && String(f.failure?.message).includes("顶掉")), "接回旧会话时被拒并出卡");
  expect(h.runs()).toHaveLength(1);
}, 30_000);

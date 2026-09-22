#!/usr/bin/env bun
/**
 * Codex 通道端到端验证：exec 引导 → buildCodexCommand 起 TUI → 假 bridge 收 register →
 * 推 message 帧 → CodexQueueSink 经 `codex queue` 投进会话 → 模型调 reply → 假 bridge 收
 * reply → Stop hook 打到假 bridge。顺带验证 CC 模式的 register 帧没多字段。
 *
 * 不碰生产：独立 tmux socket（-L）、只绑 127.0.0.1 的假 bridge、工作目录由 --dir 指定。
 * 会真实调用 Codex（两轮左右，订阅额度），并在 ~/.codex 留下一个会话；Codex 自己还可能
 * 往 ~/.codex/config.toml 追加该目录的 projects 信任记录（脚本只报告，不回滚）。
 *
 * 用法：bun scripts/codex-e2e.ts --dir <scratch 目录> [--port 38591] [--thread <sid>] [--keep]
 *   --thread：复用已有线程（跳过 exec 引导、不新开 Codex 会话），TUI 走 resume。该线程的
 *   rollout 必须已有至少一轮，且 --dir 与它的 cwd 一致。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapArgs, buildCodexCommand, parseBootstrapThreadId, resolveCodexBinary } from "../src/lib/codex-launch.js";
import { channelInstructions } from "../src/lib/channel-instructions.js";
import { defaultRunner } from "../src/lib/codex-thread.js";
import { findCodexSessionPath } from "../src/lib/codex-session.js";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const DIR = opt("--dir");
if (!DIR) {
  console.error("用法: bun scripts/codex-e2e.ts --dir <scratch 目录> [--port 38591] [--keep]");
  process.exit(2);
}
const PORT = Number(opt("--port", "38591"));
const KEEP = args.includes("--keep");
const REUSE_THREAD = opt("--thread");
const REPO = resolve(import.meta.dir, "..");
const WORK = join(resolve(DIR), "work");
const SOCK = `p3b-e2e-${process.pid}`;
const CHANNEL = "999000222";
const AGENT = "agent-codex-e2e";
mkdirSync(WORK, { recursive: true });

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sha = (p: string) => (existsSync(p) ? new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex").slice(0, 12) : "-");
const CODEX_CONFIG = join(process.env.HOME || "", ".codex", "config.toml");
const configBefore = sha(CODEX_CONFIG);

// ── 假 bridge ──────────────────────────────────────────────────────────────
type Frame = { at: number; msg: any };
const frames: Frame[] = [];
const hooks: Frame[] = [];
const sockets = new Map<string, any>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req, srv) {
    if (srv.upgrade(req)) return;
    const url = new URL(req.url);
    if (url.pathname === "/hook" && req.method === "POST") {
      hooks.push({ at: Date.now(), msg: await req.json().catch(() => null) });
      return Response.json({ ok: true });
    }
    return new Response("nf", { status: 404 });
  },
  websocket: {
    message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "ping") return;
      frames.push({ at: Date.now(), msg });
      if (msg.type === "register") {
        sockets.set(msg.channelId, ws);
        ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));
      } else if (msg.requestId) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ["fake-1"] } }));
      }
    },
  },
});
log(`假 bridge 127.0.0.1:${PORT}`);

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v as T;
    await Bun.sleep(250);
  }
  throw new Error(`等待超时: ${what}`);
}
const tmux = (...a: string[]) => defaultRunner(["tmux", "-L", SOCK, ...a], 10_000);

const summary: Record<string, unknown> = {};
let failed = false;
try {
  // ── 0. CC 模式 register 帧不带 Codex 字段 ───────────────────────────────
  {
    const cc = Bun.spawn(["bun", join(REPO, "src", "channel-server.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...process.env, DISCORD_CHANNEL_ID: "999000221", BRIDGE_URL: `ws://127.0.0.1:${PORT}`, CLAUDESTRA_RUNTIME: "" },
    });
    const rpc = (o: unknown) => cc.stdin.write(JSON.stringify(o) + "\n");
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
    await Bun.sleep(300);
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    const reg = await waitFor("CC register", () => frames.find((f) => f.msg.type === "register" && f.msg.channelId === "999000221"), 10_000);
    summary.ccRegisterKeys = Object.keys(reg.msg);
    if (JSON.stringify(Object.keys(reg.msg)) !== JSON.stringify(["type", "channelId", "cwd", "pid", "ppid"])) {
      throw new Error(`CC register 帧字段变了: ${Object.keys(reg.msg)}`);
    }
    // stdin EOF 不会让 channel-server 退出（MCP SDK 的 stdio transport 不监听 end），显式杀掉
    cc.kill();
    await Promise.race([cc.exited, Bun.sleep(3000)]);
    log("CC 模式 register 帧字段:", summary.ccRegisterKeys);
  }

  // ── 1. exec 引导 ────────────────────────────────────────────────────────
  const bin = await resolveCodexBinary(defaultRunner);
  if (!bin) throw new Error("登录 shell 里找不到 codex");
  const version = (await defaultRunner([bin.real, "--version"], 20_000)).out.trim();
  summary.codex = { ...bin, version };
  log("codex:", bin.real, version);
  const rules = channelInstructions(REPO);
  let threadId: string | null = REUSE_THREAD ?? null;
  if (threadId) {
    summary.bootstrap = { reused: threadId };
    log("复用 thread:", threadId);
  } else {
    const argv = bootstrapArgs({ codexBin: bin.real, cwd: WORK, agentName: AGENT, purpose: "端到端测试", effort: "low", channelRules: rules });
    const boot = Bun.spawn(argv, { cwd: WORK, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const bootOut = await new Response(boot.stdout).text();
    await boot.exited;
    threadId = parseBootstrapThreadId(bootOut);
    summary.bootstrap = { exit: boot.exitCode, firstLine: bootOut.split("\n")[0], threadId };
    if (!threadId) throw new Error(`exec 引导没拿到 thread id: ${bootOut.slice(0, 300)}`);
    log("引导 thread:", threadId);
  }

  // ── 2. 起 TUI ───────────────────────────────────────────────────────────
  await tmux("new-session", "-d", "-s", "e2e", "-x", "220", "-y", "50", "-c", WORK);
  const pane = (await tmux("display-message", "-p", "-t", "e2e", "#{pane_id}")).out.trim();
  await tmux("set-option", "-w", "-t", pane, "-u", "@claudestra_ready");
  const cmd = buildCodexCommand(
    {
      mode: REUSE_THREAD ? "resume" : "new", sessionId: threadId, agentName: AGENT, channelId: CHANNEL,
      bridgeUrl: `ws://127.0.0.1:${PORT}`, bridgePort: String(PORT), cwd: WORK,
      codexBin: bin.real, bunBin: process.execPath, claudestraHome: REPO,
      purpose: "端到端测试", effort: "low",
    },
    rules,
  );
  summary.launchCommandBytes = Buffer.byteLength(cmd);
  await Bun.sleep(800); // 等登录 shell 起来
  await tmux("send-keys", "-t", pane, "-l", "--", cmd);
  await Bun.sleep(150);
  await tmux("send-keys", "-t", pane, "Enter");
  log(`已发启动命令（${summary.launchCommandBytes} 字节）`);

  const reg = await waitFor("Codex register", () => frames.find((f) => f.msg.type === "register" && f.msg.channelId === CHANNEL), 60_000);
  summary.register = reg.msg;
  log("register:", JSON.stringify(reg.msg));
  if (reg.msg.runtime !== "codex" || reg.msg.sessionId !== threadId) throw new Error("register 帧的 runtime/sessionId 不对");
  if ("sessionFile" in reg.msg) throw new Error("Codex register 帧不该自报 sessionFile");
  // channel-server 的父进程 = 持线程锁的那个进程；npm 壳被换成原生二进制后它应直接是 pane 的子进程
  const parentCmd = (await defaultRunner(["ps", "-o", "command=", "-p", String(reg.msg.ppid)], 5_000)).out.trim();
  const paneChild = (await defaultRunner(["pgrep", "-P", (await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).out.trim()], 5_000)).out.trim().split("\n")[0];
  summary.processTree = { channelServerParent: parentCmd.slice(0, 160), parentIsPaneChild: String(reg.msg.ppid) === paneChild };
  log("进程树:", JSON.stringify(summary.processTree));
  let readyVal = "";
  for (let i = 0; i < 40 && readyVal !== "1"; i++) {
    readyVal = (await tmux("show-options", "-w", "-v", "-t", pane, "@claudestra_ready")).out.trim();
    if (readyVal !== "1") await Bun.sleep(250);
  }
  summary.readyMarker = readyVal;
  log("@claudestra_ready =", readyVal);
  if (readyVal !== "1") throw new Error("就绪标记没写上");

  // ── 3. 推一条消息 → 等 reply → 等 Stop hook ──────────────────────────────
  const pushedAt = Date.now();
  sockets.get(CHANNEL).send(JSON.stringify({
    type: "message",
    content: "这是 Claudestra 端到端测试。请调用 claudestra 的 reply 工具回复：chat_id 用 <channel> 标签里的 chat_id，text 严格写 E2E-PONG。不要做别的。",
    meta: { chat_id: CHANNEL, user: "e2e", message_id: "e2e-1" },
  }));
  log("已推 message 帧");
  const reply = await waitFor("reply 帧", () => frames.find((f) => f.at >= pushedAt && f.msg.type === "reply"), 180_000);
  summary.reply = { ...reply.msg, afterMs: reply.at - pushedAt };
  log("reply:", JSON.stringify(reply.msg), `（${reply.at - pushedAt}ms）`);
  if (!String(reply.msg.text).includes("E2E-PONG")) throw new Error("reply 内容不对");
  const stop = await waitFor("Stop hook", () => hooks.find((h) => h.at >= pushedAt && h.msg?.event === "Stop" && h.msg?.channelId === CHANNEL), 60_000);
  summary.stopHook = { ...stop.msg, afterMs: stop.at - pushedAt };
  log("Stop hook:", JSON.stringify(stop.msg));
  // 投进去的 <channel> 标签带 reply_via（developer_instructions 不随 resume 生效时的兜底）
  const rollout = findCodexSessionPath(threadId);
  const channelLines = rollout ? readFileSync(rollout, "utf8").split("\n").filter((l) => l.includes("e2e-1") && l.includes("<channel ")) : [];
  const lastTag = /<channel [^>]*>/.exec(channelLines.at(-1)?.replace(/\\"/g, '"') ?? "")?.[0] ?? "";
  summary.deliveredTag = lastTag;
  log("投递标签:", lastTag);
  if (!lastTag.includes("reply_via=")) throw new Error("投递的 <channel> 标签缺 reply_via");
  summary.allFrames = frames.map((f) => f.msg.type);
} catch (e) {
  failed = true;
  summary.error = (e as Error).message;
  console.error("❌", (e as Error).message);
  const cap = await tmux("capture-pane", "-p", "-t", "e2e", "-S", "-40");
  summary.paneTail = cap.out.split("\n").filter((l) => l.trim()).slice(-25);
} finally {
  if (!KEEP) {
    // 先 /quit 等回到 shell 再杀 tmux：直接杀会把线程写锁文件留在 ~/.codex（无人持有，无害但脏）
    await tmux("send-keys", "-t", "e2e", "-l", "--", "/quit");
    await Bun.sleep(300);
    await tmux("send-keys", "-t", "e2e", "Enter");
    for (let i = 0; i < 20; i++) {
      const cur = (await tmux("display-message", "-p", "-t", "e2e", "#{pane_current_command}")).out.trim();
      if (/^-?(zsh|bash|sh|fish)$/.test(cur)) break;
      await Bun.sleep(500);
    }
    await tmux("kill-server");
    server.stop(true);
  }
  summary.codexConfigSha = { before: configBefore, after: sha(CODEX_CONFIG) };
  console.log(JSON.stringify(summary, null, 2));
  if (!KEEP) process.exit(failed ? 1 : 0);
}

#!/usr/bin/env bun
/**
 * Codex **适配器**端到端（P3c）：走 runtimes/codex.ts 本身，而不是手拼命令——
 *   available → prepareSession(new, exec 引导) → beforeLaunch → buildLaunchCommand → waitReady
 *   → 假 bridge 推 message → CodexQueueSink 投递 → reply → Stop hook
 *   → gracefulExitWindow（**生产的退出序列**，与 manager restart / kill 同一段代码；空闲 → 不发 Esc）
 *   → 同一窗口 resume 模式再拉起同一线程 → 前言随第一条投递送达 → 问上一轮的暗号，确认上下文还在
 *   → discoverSessionId 按线程写锁认出窗口里的线程
 *   → 投一条会跑 sleep 的消息，趁回合在跑时 gracefulExitWindow（忙 → 恰好一个 Esc 再 /quit）
 *   每次退出都断言：回到 shell，且 rollout 里没有多出一轮（task_started 数不变）——
 *   旧序列 Esc×3 会打开 backtrack 遮罩，"/quit" 的 "uit" 被当成一轮用户消息发给模型
 *
 * 不碰生产：独立 tmux socket（-L，WindowOps 在本脚本里自己实现——接口本来就是为注入设计的，
 * 不动 tmux-helper 的 socket 常量）、只绑 127.0.0.1 的假 bridge、工作目录由 --dir 指定。
 * 会真实调用 Codex（引导 1 轮 + 对话 2 轮，订阅额度），在 ~/.codex 留下一个会话；Codex 自己
 * 可能往 ~/.codex/config.toml 追加该目录的 projects 信任记录（脚本只报告 sha，不回滚）。
 *
 * 用法：bun scripts/codex-adapter-e2e.ts --dir <scratch 目录> [--port 38592]
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findCodexSessionPath } from "../src/lib/codex-session.js";
import { CONTEXT_PREAMBLE_MARKER, defaultRunner } from "../src/lib/codex-thread.js";
import { createCodexAdapter } from "../src/lib/runtimes/codex.js";
import { codexBusy } from "../src/lib/runtimes/codex-exit.js";
import { gracefulExitWindow } from "../src/lib/runtimes/graceful-exit.js";
import type { LaunchSpec, WindowOps } from "../src/lib/runtimes/types.js";
import { isAtShell } from "../src/lib/tmux-helper.js";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const DIR = opt("--dir");
if (!DIR) {
  console.error("用法: bun scripts/codex-adapter-e2e.ts --dir <scratch 目录> [--port 38592]");
  process.exit(2);
}
const PORT = Number(opt("--port", "38592"));
const WORK = join(resolve(DIR), "work");
const SOCK = `p3c-e2e-${process.pid}`;
const CHANNEL = "999000333";
const WINDOW = "agent-codex-p3c";
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
log(`假 bridge 127.0.0.1:${PORT}，tmux -L ${SOCK}`);

type Maybe<T> = T | undefined | null | false;
async function waitFor<T>(what: string, fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(250);
  }
  throw new Error(`等待超时: ${what}`);
}
const tmux = (...a: string[]) => defaultRunner(["tmux", "-L", SOCK, ...a], 10_000);

// ── 独立 socket 上的 WindowOps ────────────────────────────────────────────
const target = `e2e:${WINDOW}`;
async function panePid(): Promise<number> {
  return Number((await tmux("display-message", "-p", "-t", target, "#{pane_pid}")).out.trim());
}
const win: WindowOps = {
  name: WINDOW,
  target,
  capture: async (lines = 40) => (await tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`)).out,
  sendLine: async (text) => {
    await tmux("send-keys", "-t", target, "-l", "--", text);
    await Bun.sleep(150);
    await tmux("send-keys", "-t", target, "Enter");
  },
  sendLiteral: async (text) => { await tmux("send-keys", "-t", target, "-l", "--", text); },
  sendKey: async (key) => { await tmux("send-keys", "-t", target, key); },
  sendEscape: async () => { await tmux("send-keys", "-t", target, "Escape"); },
  getOption: async (key) => {
    const r = await tmux("show-options", "-w", "-v", "-t", target, key);
    return r.ok ? r.out.trim() : null;
  },
  setOption: async (key, value) => (await tmux("set-option", "-w", "-t", target, key, value)).ok,
  childPids: async () => {
    const r = await defaultRunner(["pgrep", "-P", String(await panePid())], 5_000);
    return r.out.split("\n").map((s) => Number(s.trim())).filter((n) => n > 1);
  },
  sleep: (ms) => Bun.sleep(ms),
};

const adapter = createCodexAdapter({ childPids: () => win.childPids() });

/** rollout 里的回合数（每轮用户消息一个 task_started）：退出前后必须相等 */
function turnCount(sid: string): number {
  const p = findCodexSessionPath(sid);
  return p ? readFileSync(p, "utf8").split("\n").filter((l) => l.includes('"type":"task_started"')).length : -1;
}

/** 走生产的 gracefulExitWindow；断言回到 shell、没有多出一轮 */
async function gracefulExit(label: string, sid: string): Promise<{ ms: number; keys: string[]; turnsBefore: number; turnsAfter: number }> {
  const keys: string[] = [];
  const spy: WindowOps = {
    ...win,
    sendKey: async (k) => { keys.push(k); await win.sendKey(k); },
    sendEscape: async () => { keys.push("Escape"); await win.sendEscape(); },
    sendLiteral: async (t) => { keys.push(`"${t}"`); await win.sendLiteral(t); },
  };
  const turnsBefore = turnCount(sid);
  const at = Date.now();
  const ok = await gracefulExitWindow(spy, adapter);
  const ms = Date.now() - at;
  const cur = (await tmux("display-message", "-p", "-t", target, "#{pane_current_command}")).out.trim();
  await Bun.sleep(1500); // rollout 落盘
  const turnsAfter = turnCount(sid);
  log(`${label}: gracefulExitWindow=${ok}（${ms}ms）按键 ${keys.join(" ")}；pane 命令 ${cur}；回合数 ${turnsBefore} → ${turnsAfter}`);
  if (!ok || !/^-?(zsh|bash|sh|fish)$/.test(cur)) throw new Error(`${label}: 没回到 shell（${cur}）`);
  if (ms > 20_000) throw new Error(`${label}: 退出用了 ${ms}ms——走到了强杀兜底`);
  if (turnsAfter !== turnsBefore) throw new Error(`${label}: 退出多出了 ${turnsAfter - turnsBefore} 轮（按键被当成用户消息）`);
  if (keys.filter((k) => k === "Escape").length > 1) throw new Error(`${label}: 连发了 Esc`);
  return { ms, keys, turnsBefore, turnsAfter };
}

async function launch(spec: LaunchSpec, label: string) {
  const at = Date.now();
  await adapter.beforeLaunch!(win);
  await win.sendLine(adapter.buildLaunchCommand(spec));
  const ready = await adapter.waitReady(win, { rounds: 240, pollMs: 500 });
  log(`${label}: waitReady =`, JSON.stringify(ready), `（${Date.now() - at}ms）`);
  if (!ready.ready) throw new Error(`${label}: 没就绪 ${JSON.stringify(ready)}`);
  return Date.now() - at;
}

async function roundTrip(content: string, messageId: string, expect: RegExp, label: string) {
  const pushedAt = Date.now();
  sockets.get(CHANNEL).send(JSON.stringify({
    type: "message",
    content,
    meta: { chat_id: CHANNEL, user: "e2e", message_id: messageId },
  }));
  const reply = await waitFor(`${label} reply`, () => frames.find((f) => f.at >= pushedAt && f.msg.type === "reply"), 240_000);
  log(`${label} reply:`, JSON.stringify(reply.msg.text), `（${reply.at - pushedAt}ms）`);
  if (!expect.test(String(reply.msg.text))) throw new Error(`${label}: reply 内容不对: ${reply.msg.text}`);
  const stop = await waitFor(`${label} Stop hook`, () => hooks.find((h) => h.at >= pushedAt && h.msg?.event === "Stop" && h.msg?.channelId === CHANNEL), 90_000);
  log(`${label} Stop hook:`, JSON.stringify(stop.msg));
  return { text: reply.msg.text, replyMs: reply.at - pushedAt, stopMs: stop.at - pushedAt };
}

const summary: Record<string, unknown> = {};
let failed = false;
try {
  // ── 0. 可用性 ────────────────────────────────────────────────────────────
  const avail = await adapter.available();
  summary.available = avail;
  if (!avail.ok) throw new Error(`codex 不可用: ${avail.hint}`);
  const version = (await defaultRunner([adapter.binPath()!, "--version"], 20_000)).out.trim();
  summary.codex = { bin: adapter.binPath(), version };
  log("codex:", adapter.binPath(), version);

  // ── 1. new：exec 引导 ────────────────────────────────────────────────────
  const base: LaunchSpec = {
    mode: "new",
    channelId: CHANNEL,
    bridgeUrl: `ws://127.0.0.1:${PORT}`,
    sessionId: crypto.randomUUID(),
    agentName: WINDOW,
    purpose: "P3c 适配器端到端测试",
    cwd: WORK,
    effort: "low",
  };
  const bootAt = Date.now();
  const { sessionId: sid } = await adapter.prepareSession!(base);
  summary.bootstrap = { threadId: sid, ms: Date.now() - bootAt };
  log("引导 thread:", sid, `（${Date.now() - bootAt}ms）`);
  const spec: LaunchSpec = { ...base, sessionId: sid };

  // ── 2. 起窗口 + 启动 + 就绪 ──────────────────────────────────────────────
  await tmux("new-session", "-d", "-s", "e2e", "-n", WINDOW, "-x", "220", "-y", "50", "-c", WORK);
  for (let i = 0; i < 30 && !isAtShell(await win.capture(3)); i++) await Bun.sleep(300);
  summary.launch1Ms = await launch(spec, "第一轮（new）");
  const reg1 = frames.find((f) => f.msg.type === "register" && f.msg.channelId === CHANNEL)!;
  summary.register1 = reg1.msg;
  if (reg1.msg.runtime !== "codex" || reg1.msg.sessionId !== sid) throw new Error("register 帧的 runtime/sessionId 不对");

  // ── 3. 投递 → reply → Stop ────────────────────────────────────────────────
  summary.turn1 = await roundTrip(
    "这是 Claudestra 端到端测试。请记住暗号 P3C-ALPHA-7，然后调用 claudestra 的 reply 工具回复：chat_id 用 <channel> 标签里的 chat_id，text 严格写 E2E-PONG。不要做别的。",
    "p3c-1",
    /E2E-PONG/,
    "第一轮",
  );

  // ── 4. 优雅退出 ─────────────────────────────────────────────────────────
  summary.exit1 = await gracefulExit("第一轮（空闲退出）", sid);

  // ── 5. resume 同一线程（同一窗口，模拟 restart）───────────────────────────
  const regCount = frames.filter((f) => f.msg.type === "register").length;
  summary.launch2Ms = await launch({ ...spec, mode: "resume", purpose: "P3c 适配器端到端测试（重启后）" }, "第二轮（resume）");
  const reg2 = frames.filter((f) => f.msg.type === "register")[regCount];
  summary.register2 = reg2?.msg;
  if (reg2?.msg.sessionId !== sid) throw new Error(`resume 后 register 的 sessionId 不对: ${reg2?.msg.sessionId}`);

  const found = await adapter.discoverSessionId!({ windowName: WINDOW, cwd: WORK, timeoutMs: 5_000 });
  summary.discover = found;
  log("discoverSessionId:", JSON.stringify(found));
  if (found?.sessionId !== sid) throw new Error("discoverSessionId 没认出窗口里的线程");

  summary.turn2 = await roundTrip(
    "上一轮我让你记住的暗号是什么？请调用 claudestra 的 reply 工具只回复那个暗号本身。",
    "p3c-2",
    /P3C-ALPHA-7/,
    "第二轮（上下文）",
  );

  // 前言只附在重启后的第一条投递上，且历史翻译会剥掉它
  const rollout = findCodexSessionPath(sid);
  const raw = rollout ? readFileSync(rollout, "utf8") : "";
  const preambleLines = raw.split("\n").filter((l) => l.includes(CONTEXT_PREAMBLE_MARKER));
  summary.preamble = {
    rollout,
    deliveriesWithPreamble: preambleLines.filter((l) => l.includes('"response_item"')).length,
    carriesNewPurpose: preambleLines.some((l) => l.includes("重启后")),
  };
  log("前言:", JSON.stringify(summary.preamble));
  if (!(summary.preamble as any).carriesNewPurpose) throw new Error("resume 后的第一条投递没带前言");

  // ── 6. 回合在跑时退出（restart 撞上忙 agent 的情形）──────────────────────
  const busyAt = Date.now();
  sockets.get(CHANNEL).send(JSON.stringify({
    type: "message",
    content: "请用 shell 工具执行 `sleep 40`，结束后调用 claudestra 的 reply 工具回复 SLEPT。",
    meta: { chat_id: CHANNEL, user: "e2e", message_id: "p3c-3" },
  }));
  await waitFor("回合开始（pane 出现 esc to interrupt）", async () => codexBusy(await win.capture(40)), 90_000);
  log(`第三轮已在跑（${Date.now() - busyAt}ms），开始退出`);
  summary.exit2 = await gracefulExit("第三轮（忙时退出）", sid);
  if ((summary.exit2 as any).keys.filter((k: string) => k === "Escape").length !== 1) throw new Error("忙时退出应恰好发一个 Esc");
  if (frames.some((f) => f.at >= busyAt && f.msg.type === "reply")) log("⚠ 退出前模型已 reply（sleep 太短？）");
  summary.allFrames = frames.map((f) => f.msg.type);
} catch (e) {
  failed = true;
  summary.error = (e as Error).message;
  console.error("❌", (e as Error).message);
  summary.paneTail = (await win.capture(40).catch(() => "")).split("\n").filter((l) => l.trim()).slice(-25);
  await tmux("send-keys", "-t", target, "-l", "--", "/quit");
  await Bun.sleep(300);
  await tmux("send-keys", "-t", target, "Enter");
  await Bun.sleep(3000);
} finally {
  await tmux("kill-server");
  server.stop(true);
  summary.codexConfigSha = { before: configBefore, after: sha(CODEX_CONFIG) };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed ? 1 : 0);
}

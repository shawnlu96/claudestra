/**
 * channel-server 真进程 + 本地假 bridge：钉住两种模式对外的形状。
 *
 * - CC 模式是 Claude Code 与 bridge 之间的契约，Codex 模式加进来后必须逐字不变：
 *   register 帧字段、入站 → notifications/claude/channel、工具清单里有 ask_codex。
 * - Codex 模式：register 自报 runtime / sessionId（不报 sessionFile），隐藏 ask_codex，
 *   线程不在线时入站不走 MCP 通知，而是回一条「未投递」给发消息的人。
 *
 * env 从零拼（不继承 TMUX / TMUX_PANE / DISCORD_CHANNEL_ID）：跑测试的进程可能就在生产
 * tmux 里，继承了就会去改真实 pane 的选项、连真实 bridge。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OFFLINE_NOTICE } from "../src/lib/codex-thread.js";

const SERVER = join(import.meta.dir, "..", "src", "channel-server.ts");

type Frame = { msg: any; ws: any };
let bridge: ReturnType<typeof Bun.serve>;
const frames: Frame[] = [];

beforeAll(() => {
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("nf", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === "ping") return;
        frames.push({ msg, ws });
        if (msg.type === "register") ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));
        else if (msg.requestId) ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ["m"] } }));
      },
    },
  });
});
afterAll(() => bridge.stop(true));

async function waitFor<T>(what: string, fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(20);
  }
  throw new Error(`等待超时: ${what}`);
}

/** 起一个 channel-server，完成 MCP 握手，返回收发工具 */
async function startServer(channelId: string, extraEnv: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, SERVER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      DISCORD_CHANNEL_ID: channelId,
      BRIDGE_URL: `ws://127.0.0.1:${bridge.port}`,
      ...extraEnv,
    },
  });
  const out: any[] = [];
  (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) try { out.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
      }
    }
  })();
  const rpc = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
  rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await waitFor("initialize 响应", () => out.find((m) => m.id === 1));
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const reg = await waitFor(`register ${channelId}`, () => frames.find((f) => f.msg.type === "register" && f.msg.channelId === channelId));
  rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await waitFor("tools/list 响应", () => out.find((m) => m.id === 2));
  return {
    proc,
    out,
    reg: reg.msg,
    ws: reg.ws,
    tools: (list.result.tools as Array<{ name: string }>).map((t) => t.name),
    stop: async () => { proc.kill(); await Promise.race([proc.exited, Bun.sleep(2000)]); },
  };
}

describe("channel-server CC 模式（契约逐字不变）", () => {
  test("register 帧 / 入站通知 / 工具清单", async () => {
    const s = await startServer("999000401", {});
    try {
      expect(Object.keys(s.reg)).toEqual(["type", "channelId", "cwd", "pid", "ppid"]);
      expect(s.reg.pid).toBe(s.proc.pid);
      expect(s.tools).toContain("reply");
      expect(s.tools).toContain("ask_codex");

      s.ws.send(JSON.stringify({ type: "message", content: "hi", meta: { chat_id: "999000401", user: "u", message_id: "1" } }));
      const n = await waitFor("channel 通知", () => s.out.find((m) => m.method === "notifications/claude/channel"));
      expect(n.params).toEqual({ content: "hi", meta: { chat_id: "999000401", user: "u", message_id: "1" } });
    } finally {
      await s.stop();
    }
  }, 15_000);
});

describe("channel-server Codex 模式", () => {
  test("自报 runtime/sessionId、隐藏 ask_codex；线程不在线时回「未投递」而不是发 MCP 通知", async () => {
    const sid = "01a0ca67-40be-7563-a599-78cc370fe748";
    const s = await startServer("999000402", {
      CLAUDESTRA_RUNTIME: "codex",
      CLAUDESTRA_AGENT: "t-codex",
      CLAUDESTRA_SESSION_ID: sid,
      // 本测试进程不持有任何 Codex 线程锁 → 判离线，queue 不会被调到；万一调到也只会失败
      CLAUDESTRA_CODEX_BIN: "/usr/bin/false",
    });
    try {
      expect(s.reg).toMatchObject({ type: "register", channelId: "999000402", runtime: "codex", agentName: "t-codex", sessionId: sid });
      expect("sessionFile" in s.reg).toBe(false);
      expect(s.tools).toContain("reply");
      expect(s.tools).not.toContain("ask_codex");

      const before = frames.length;
      s.ws.send(JSON.stringify({ type: "message", content: "hi", meta: { chat_id: "api:t", user: "u" } }));
      const r = await waitFor("未投递提示", () => frames.slice(before).find((f) => f.msg.type === "reply")?.msg);
      expect(r.chatId).toBe("api:t");
      expect(r.text).toBe(OFFLINE_NOTICE);
      expect(s.out.some((m) => m.method === "notifications/claude/channel")).toBe(false);
    } finally {
      await s.stop();
    }
  }, 15_000);
});

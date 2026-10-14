/**
 * SYN-1 验收 1 / 2 / 5：切回看过的 agent 只拉差量、推送流不等历史就开、横幅在差量期间亮；冷启动首页 150 条。
 * 真 ChatStore + 真 lib/api（history / stream / client），fetch 换成本文件的合成 bridge：历史页可手动挂起，/events 是可推帧的 SSE。
 * 切换时的事件闸见 web/features/chat/switch-sync.ts。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { ChatMessage } from "../web/features/chat/type";

interface Store {
  openAgent(name: string): Promise<void>;
  readonly state: { messages: ChatMessage[]; syncState: string | null; activeAgent: string };
}
interface Msg { seq: number; role: "user" | "assistant"; text: string; ts: string }

const enc = new TextEncoder();
const realFetch = globalThis.fetch;
const sessions: Record<string, Msg[]> = {};
const calls: string[] = [];
const streams: { agents: string; push(e: unknown): void }[] = [];
let holdDelta: Promise<void> | null = null;
let bridgeSeq = 1000;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const msg = (seq: number, role: Msg["role"], text: string): Msg => ({ seq, role, text, ts: new Date(Date.UTC(2026, 9, 14, 4, 0, seq)).toISOString() });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
  calls.push(url.pathname + url.search);
  const p = url.pathname.replace(/^\/api\/v1/, "");
  if (p === "/events") {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
    init?.signal?.addEventListener("abort", () => { try { ctrl.close(); } catch { /* 已关 */ } });
    streams.push({ agents: url.searchParams.get("agents") ?? "", push: (e) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) });
    ctrl.enqueue(enc.encode(": connected\n\n"));
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  const list = /^\/agents\/([^/]+)\/history$/.exec(p);
  if (list) return json({ sessions: sessions[list[1]] ? [{ sessionId: `s-${list[1]}` }] : [] });
  const page = /^\/agents\/([^/]+)\/history\/s-([^/]+)$/.exec(p);
  if (page) {
    const all = sessions[page[1]] ?? [];
    const after = url.searchParams.get("after");
    if (after !== null) {
      if (holdDelta) await holdDelta;
      return json({ messages: all.filter((m) => m.seq > Number(after)) });
    }
    return json({ messages: all.slice(-Number(url.searchParams.get("limit"))) });
  }
  if (/^\/agents\/[^/]+\/(hidden|pending)$/.test(p)) return json(p.endsWith("hidden") ? { ranges: [] } : {});
  if (/^\/agents\/[^/]+\/bg-tasks$/.test(p)) return json({ tasks: [] });
  return json({ error: "not found" }, 404);
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`等不到：${what}`);
}
const texts = (s: Store) => s.state.messages.map((m) => m.content);
/** watcher 的直播 assistant_text：data.seq / sid = jsonl 行号与会话（差量覆盖判重的依据） */
const liveText = (agent: string, seq: number, text: string) => ({
  seq: ++bridgeSeq, ts: new Date().toISOString(), agent: `agent-${agent}`, chatId: "", type: "assistant_text", data: { text, seq, sid: `s-${agent}` },
});

let ChatStore: new () => Store;
beforeAll(async () => {
  globalThis.fetch = fakeFetch as typeof fetch;
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "" });
  // 根 tsc 解析不了 chat-store 牵到的 zenith 别名，只能按运行时路径导入
  const spec = "@/features/chat/chat-store";
  ({ ChatStore } = (await import(spec)) as { ChatStore: new () => Store });
});
afterAll(() => void (globalThis.fetch = realFetch));
beforeEach(() => {
  for (const k of Object.keys(sessions)) delete sessions[k];
  calls.length = 0;
  streams.length = 0;
  holdDelta = null;
});

test("冷启动整页只要 150 条", async () => {
  sessions.cold = Array.from({ length: 400 }, (_, i) => msg(i + 1, i % 2 ? "assistant" : "user", `m${i + 1}`));
  const store = new ChatStore();
  await store.openAgent("cold");
  expect(calls.some((c) => c.startsWith("/api/v1/agents/cold/history/s-cold?limit=150"))).toBe(true);
  expect(calls.some((c) => c.includes("limit=500"))).toBe(false);
});

test("切回看过的 agent：只发差量、流先开、横幅亮到差量落地；排队的直播事件不重复不丢", async () => {
  sessions.x = [msg(1, "user", "hi"), msg(2, "assistant", "hello")];
  sessions.y = [msg(1, "user", "yo")];
  const store = new ChatStore();
  await store.openAgent("x");
  await store.openAgent("y");
  sessions.x.push(msg(3, "user", "while away"), msg(4, "assistant", "reply while away"));

  let release!: () => void;
  holdDelta = new Promise<void>((r) => (release = r));
  calls.length = 0;
  streams.length = 0;
  const opened = store.openAgent("x");
  // 差量还挂着，流已经连上
  await until(() => streams.some((s) => s.agents.includes("x")), "x 的推送流");
  await until(() => calls.some((c) => c.includes("/history/s-x?") && c.includes("after=2")), "x 的差量请求");
  expect(calls.filter((c) => c.includes("/history/s-x?") && !c.includes("after="))).toEqual([]); // 不整页重拉
  expect(store.state.syncState).toBe("syncing"); // 流连上不收横幅——差量还在补
  expect(texts(store)).toEqual(["hi", "hello"]); // 先秒开快照

  // 差量在途时流上来两条：seq 4 已在差量里（该被判重丢掉），seq 5 是之后的新输出
  const live = streams.find((s) => s.agents.includes("x"))!;
  live.push(liveText("x", 4, "reply while away"));
  live.push(liveText("x", 5, "fresh live"));
  await tick(20);
  expect(texts(store)).toEqual(["hi", "hello"]); // 排队中，视图不动

  release();
  await opened;
  await until(() => texts(store).includes("fresh live"), "放行后的直播气泡");
  expect(texts(store)).toEqual(["hi", "hello", "while away", "reply while away", "fresh live"]);
  expect(store.state.syncState).toBeNull();
});

test("没有快照的 agent 照旧整页，流同样不等历史", async () => {
  sessions.z = [msg(1, "user", "a"), msg(2, "assistant", "b")];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realHold = fakeFetch;
  globalThis.fetch = (async (i: string | URL | Request, init?: RequestInit) => {
    if (String(i).includes("/history/s-z?limit=")) await gate;
    return realHold(i, init);
  }) as typeof fetch;
  try {
    const store = new ChatStore();
    const opened = store.openAgent("z");
    await until(() => streams.some((s) => s.agents.includes("z")), "z 的推送流");
    release();
    await opened;
    expect(texts(store)).toEqual(["a", "b"]);
  } finally {
    globalThis.fetch = fakeFetch as typeof fetch;
  }
});

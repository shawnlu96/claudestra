/**
 * SYN-1 验收 4：连流补拉（/pending、/bg-tasks）不再挡实时事件——实时事件先放，快照到了再按 ReplayMerge 合入，
 * 实时事件已经说过的不拿快照往回拨（不重复、不乱序）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { WebStreamEvent } from "../web/lib/chat/events";

interface Merge { see(e: WebStreamEvent): void; merge(snapshot: WebStreamEvent[]): WebStreamEvent[] }
interface Reader { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> }
// 根 tsc 不开 jsx，连 import type 都会经 lib/api/history 牵进 lib/i18n.tsx；按运行时路径导入，只声明用到的公开面
const spec = "@/lib/api/stream";
const { openAgentEventStream, ReplayMerge } = (await import(spec)) as {
  openAgentEventStream(agent: string, opts: { lang: "zh" }): Promise<{ getReader(): Reader }>;
  ReplayMerge: new () => Merge;
};

const realFetch = globalThis.fetch;
const enc = new TextEncoder();
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
let push!: (e: unknown) => void;
let answerPending!: (v: unknown) => void;
let answerBg!: (v: unknown) => void;

beforeAll(() => {
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost/").pathname;
    if (path === "/api/v1/events") {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))) });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/pending")) return new Promise((r) => (answerPending = (v) => r(json(v))));
    if (path.endsWith("/bg-tasks")) return new Promise((r) => (answerBg = (v) => r(json(v))));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterAll(() => void (globalThis.fetch = realFetch));

let seq = 0;
const ev = (type: string, data: Record<string, unknown>) => ({ seq: ++seq, ts: new Date().toISOString(), agent: "agent-a", chatId: "", type, data });

/** 读帧直到拿到一个非心跳事件 */
async function next(reader: Reader): Promise<WebStreamEvent & { eid?: number }> {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("流提前结束");
    const data = dec.decode(value).replace(/^data: /, "").trim();
    if (data !== "[DONE]") return JSON.parse(data);
  }
}

test("快照没回来，实时事件照样先到；快照回来后只补实时没说过的", async () => {
  const stream = await openAgentEventStream("a", { lang: "zh" });
  const reader = stream.getReader();
  push(ev("tool_start", { name: "Bash", summary: "ls", seq: 7, sid: "s" }));
  expect(await next(reader)).toMatchObject({ t: "tool", name: "Bash" }); // /pending /bg-tasks 都还挂着
  push(ev("agent_status", { status: "done" })); // 回合在快照之前就结束了
  expect(await next(reader)).toMatchObject({ t: "done" });
  push(ev("bg_task", {})); // 不认识的类型被过滤，不影响
  answerBg({ tasks: [{ id: "b1", kind: "shell", title: "build", lines: ["ok"] }] });
  answerPending({ thinking: true, question: { questions: [], ts: 1 } }); // 快照里的 thinking 已过时
  const got = [await next(reader), await next(reader), await next(reader), await next(reader)];
  expect(got.map((e) => e.t)).toEqual(["ask", "bg-start", "bg-update", "bg-sync"]); // 没有往回拨的 status: running
  await reader.cancel();
});

test("ReplayMerge：实时已见的 bg 任务不复活；快照之后才起的任务并进 bg-sync 全集", () => {
  const m = new ReplayMerge();
  m.see({ t: "bg-start", id: "late", kind: "subagent", title: "new" });
  m.see({ t: "bg-start", id: "gone", kind: "shell", title: "x" });
  m.see({ t: "bg-done", id: "gone" });
  const out = m.merge([
    { t: "bg-start", id: "gone", kind: "shell", title: "x" },
    { t: "bg-start", id: "old", kind: "shell", title: "y" },
    { t: "bg-sync", ids: ["gone", "old"] },
  ]);
  expect(out).toEqual([
    { t: "bg-start", id: "old", kind: "shell", title: "y" },
    { t: "bg-sync", ids: ["gone", "old", "late"] },
  ]);
});

test("ReplayMerge：实时已有 ask / ask-cleared / bg-sync 时快照里的同类丢弃；什么都没见过就原样放行", () => {
  const snap: WebStreamEvent[] = [{ t: "status", status: "running" }, { t: "ask", id: "q", questions: [] }, { t: "bg-sync", ids: [] }];
  expect(new ReplayMerge().merge(snap)).toEqual(snap);
  const m = new ReplayMerge();
  m.see({ t: "ask-cleared" });
  m.see({ t: "bg-sync", ids: ["z"] });
  expect(m.merge(snap)).toEqual([{ t: "status", status: "running" }]);
});

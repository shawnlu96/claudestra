/**
 * SYN-1 验收 4：连流补拉（/pending、/bg-tasks）不再挡实时事件——聊天类实时事件先放，快照到了再按 ReplayMerge 合入，
 * 实时已说过的挂起态不拿快照往回拨；后台任务的实时增量排在快照后面放（PR1485-r1 P1：update 先到会丢 shell 的类型 / 标题 / 旧输出）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { WebStreamEvent } from "../web/lib/chat/events";

interface Merge { see(e: WebStreamEvent): void; merge(snapshot: WebStreamEvent[]): WebStreamEvent[] }
interface BgCard { id: string; kind: string; title: string; lines: string[]; status: string }
interface Store { readonly state: { bgTasks: BgCard[] } }
interface Reader { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> }
// 根 tsc 不开 jsx，连 import type 都会经 lib/api/history 牵进 lib/i18n.tsx；按运行时路径导入，只声明用到的公开面
const spec = "@/lib/api/stream";
const { openAgentEventStream, ReplayMerge } = (await import(spec)) as {
  openAgentEventStream(agent: string, opts: { lang: "zh" }): Promise<{ getReader(): Reader }>;
  ReplayMerge: new () => Merge;
};
const { ChatStore } = (await import("@/features/chat/" + "chat-store")) as { ChatStore: new () => Store };
const { processStreamEvent } = (await import("@/features/chat/" + "stream")) as { processStreamEvent(s: Store, e: WebStreamEvent): void };

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

/** 实时 bg-update 先于 /bg-tasks 快照到：store 里的卡要是快照给的类型 / 标题，旧输出在前、实时增量在后 */
async function updateBeforeSnapshot(items: string[], snapLines = ["old 1", "old 2"], coverSeq = false) {
  const store = new ChatStore();
  const stream = await openAgentEventStream("a", { lang: "zh" });
  const reader = stream.getReader();
  const progress = { startedTs: 1, lastTs: 2 };
  const up = ev("bg_task_update", { id: "sh1", kind: "shell", items, progress });
  push(up);
  push(ev("assistant_text", { text: "live chat" })); // 聊天事件不等快照
  const first = await next(reader);
  expect(first).toMatchObject({ t: "text", text: "live chat" });
  processStreamEvent(store, first);
  answerPending({});
  answerBg({ tasks: [{ id: "sh1", kind: "shell", title: "npm run build", lines: snapLines }], ...(coverSeq ? { seq: up.seq } : {}) });
  const got: WebStreamEvent[] = [];
  while (got.length < 4) got.push(await next(reader));
  expect(got.map((e) => e.t)).toEqual(["bg-start", "bg-update", "bg-sync", "bg-update"]); // 快照在前，实时增量在后
  for (const e of got) processStreamEvent(store, e);
  await reader.cancel();
  return store.state.bgTasks;
}

test("bg-update 先于快照（items 非空）：卡是快照里的 shell + 标题，旧输出在前、新输出接在后", async () => {
  const cards = await updateBeforeSnapshot(["new 3"]);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ id: "sh1", kind: "shell", title: "npm run build", status: "running" });
  expect(cards[0].lines).toEqual(["old 1", "old 2", "new 3"]);
});

test("bg-update 先于快照（items 为空，只带进度）：任务不丢", async () => {
  const cards = await updateBeforeSnapshot([]);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ id: "sh1", kind: "shell", title: "npm run build" });
  expect(cards[0].lines).toEqual(["old 1", "old 2"]);
});

/** 超过 100 行的一次增量先到被扣：快照只留最近 100 行，增量照原样接在快照后面，开头的行不能被丢（r3 bg-cover-tail-loss）。
 *  验收修订 A：bg 不做并发合并，先快照后增量；与快照重叠的行可能出现两次，但不丢 */
test("超过 100 行的 bg-update 先于快照：整条增量都接在快照后，开头不丢", async () => {
  const items = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`);
  const cards = await updateBeforeSnapshot(items, items.slice(20), true); // 快照带 seq 也不能拿它整条丢增量
  expect(cards[0]).toMatchObject({ kind: "shell", title: "npm run build" });
  expect(cards[0].lines.slice(-120)).toEqual(items);
});

test("ReplayMerge：实时已有 ask / ask-cleared 时快照里的 ask 丢弃；bg 快照原样放行（顺序由流排队保证）", () => {
  const snap: WebStreamEvent[] = [{ t: "status", status: "running" }, { t: "ask", id: "q", questions: [] }, { t: "bg-sync", ids: [] }];
  expect(new ReplayMerge().merge(snap)).toEqual(snap);
  const m = new ReplayMerge();
  m.see({ t: "ask-cleared" });
  m.see({ t: "bg-update", id: "z", items: ["x"] });
  expect(m.merge(snap)).toEqual([{ t: "status", status: "running" }, { t: "bg-sync", ids: [] }]);
});

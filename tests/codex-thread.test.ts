import { describe, expect, test } from "bun:test";
import {
  CodexQueueSink,
  OFFLINE_NOTICE,
  codexQueueArgs,
  decideDelivery,
  heldThreadIds,
  parseHeldThreadLocks,
  wrapChannelContent,
  type CmdResult,
} from "../src/lib/codex-thread.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";

const A = "01a0ca48-6b14-7cd3-b161-69a7b0918cb0";
const B = "01a0ca4e-cc5d-7f01-9a0a-18b5dfbd601a";

// `lsof -p <pid> -Fn` 的真实形状：p 行、f 行、n 行交替
const LSOF = [
  "p1600",
  "fcwd",
  "n/tmp/work",
  "f12",
  `n/Users/u/.codex/thread-writer-locks/${A}.lock`,
  "f13",
  "n/Users/u/.codex/state_5.sqlite",
  "f14",
  `n/Users/u/.codex/thread-writer-locks/${A}.lock`,
  "f15",
  "n/Users/u/.codex/thread-writer-locks/README",
].join("\n");

describe("parseHeldThreadLocks", () => {
  test("只认 thread-writer-locks/<sid>.lock，去重", () => {
    expect(parseHeldThreadLocks(LSOF)).toEqual([A]);
    expect(parseHeldThreadLocks("")).toEqual([]);
    expect(parseHeldThreadLocks(`n/x/.codex/thread-writer-locks/${A}.lock\nn/x/.codex/thread-writer-locks/${B}.lock`)).toEqual([A, B]);
  });

  test("heldThreadIds：lsof 查不到时 exit 1 也按空处理；非法 pid 不调 lsof", async () => {
    let called = 0;
    const run = async (): Promise<CmdResult> => { called++; return { ok: false, out: "", err: "" }; };
    expect(await heldThreadIds(1600, run)).toEqual([]);
    expect(await heldThreadIds(0, run)).toEqual([]);
    expect(called).toBe(1);
  });
});

describe("decideDelivery", () => {
  test("已知 sid 持锁 → queue；换了唯一一把锁 → switch；无锁 → offline；多锁猜不准 → ambiguous", () => {
    expect(decideDelivery(A, [A])).toEqual({ action: "queue", sid: A });
    expect(decideDelivery(A, [B, A])).toEqual({ action: "queue", sid: A });
    expect(decideDelivery(A, [B])).toEqual({ action: "switch", sid: B });
    expect(decideDelivery(undefined, [B])).toEqual({ action: "switch", sid: B });
    expect(decideDelivery(A, [])).toEqual({ action: "offline" });
    expect(decideDelivery(undefined, [])).toEqual({ action: "offline" });
    expect(decideDelivery(undefined, [A, B])).toEqual({ action: "ambiguous", held: [A, B] });
  });
});

describe("wrapChannelContent", () => {
  test("与 CC channel 通知同形，历史面板能照常解包", () => {
    const w = wrapChannelContent("你好\n第二行", { chat_id: "api:tok1", user: "web", message_id: "m1" }, "claudestra");
    expect(w).toBe('<channel source="claudestra" chat_id="api:tok1" user="web" message_id="m1">\n你好\n第二行\n</channel>');
    expect(unwrapChannelMessage(w)?.text).toBe("你好\n第二行");
  });
  test("属性值转义，非法键丢弃，source 不被 meta 覆盖", () => {
    const w = wrapChannelContent("x", { user: 'a"<b>', "bad key": "v", source: "evil" }, "claudestra");
    expect(w).toBe('<channel source="claudestra" user="a&quot;&lt;b&gt;">\nx\n</channel>');
  });
});

test("codexQueueArgs", () => {
  expect(codexQueueArgs("/c", A, "hi")).toEqual(["/c", "queue", "--thread", A, "--message", "hi"]);
});

function harness(initial: { sid?: string; held: string[][]; queueOk?: boolean; queueDelayMs?: number[] }) {
  let sid = initial.sid;
  let heldCall = 0;
  const queued: Array<{ sid: string; text: string }> = [];
  const notices: Array<{ chatId?: string; text: string }> = [];
  const switches: string[] = [];
  let qi = 0;
  const sink = new CodexQueueSink({
    source: "claudestra",
    getSessionId: () => sid,
    heldThreadIds: async () => initial.held[Math.min(heldCall++, initial.held.length - 1)],
    onSwitch: (s) => { sid = s; switches.push(s); },
    queue: async (s, text) => {
      const d = initial.queueDelayMs?.[qi++] ?? 0;
      if (d) await new Promise((r) => setTimeout(r, d));
      queued.push({ sid: s, text });
      return initial.queueOk === false ? { ok: false, out: "", err: "Error: boom\n" } : { ok: true, out: "Queued", err: "" };
    },
    notify: async (chatId, text) => { notices.push({ chatId, text }); },
  });
  return { sink, queued, notices, switches, sid: () => sid };
}

describe("CodexQueueSink", () => {
  test("在线：包装后投到已知线程", async () => {
    const h = harness({ sid: A, held: [[A]] });
    expect(await h.sink.deliver("hi", { chat_id: "123", user: "u" })).toEqual({ ok: true });
    expect(h.queued).toEqual([{ sid: A, text: '<channel source="claudestra" chat_id="123" user="u">\nhi\n</channel>' }]);
    expect(h.notices).toEqual([]);
  });

  test("离线：不入队（否则离线积压、下次 resume 重放），告诉发消息的人", async () => {
    const h = harness({ sid: A, held: [[]] });
    const r = await h.sink.deliver("hi", { chat_id: "api:t" });
    expect(r.ok).toBe(false);
    expect(h.queued).toEqual([]);
    expect(h.notices).toEqual([{ chatId: "api:t", text: OFFLINE_NOTICE }]);
  });

  test("线程换了：切 sid（触发重报 register）后投到新线程", async () => {
    const h = harness({ sid: A, held: [[B]] });
    await h.sink.deliver("hi", { chat_id: "1" });
    expect(h.switches).toEqual([B]);
    expect(h.queued[0].sid).toBe(B);
  });

  test("多把锁都不是已知线程：不投，告知", async () => {
    const h = harness({ sid: undefined, held: [[A, B]] });
    expect((await h.sink.deliver("hi", { chat_id: "1" })).ok).toBe(false);
    expect(h.queued).toEqual([]);
    expect(h.notices.length).toBe(1);
  });

  test("queue 失败：报给发消息的人，不静默", async () => {
    const h = harness({ sid: A, held: [[A]], queueOk: false });
    const r = await h.sink.deliver("hi", { chat_id: "1" });
    expect(r).toEqual({ ok: false, error: "Error: boom" });
    expect(h.notices[0].text).toContain("Error: boom");
  });

  test("串行：先到的先投，即使它的 queue 更慢", async () => {
    const h = harness({ sid: A, held: [[A]], queueDelayMs: [30, 0, 0] });
    await Promise.all([
      h.sink.deliver("one", { chat_id: "1" }),
      h.sink.deliver("two", { chat_id: "1" }),
      h.sink.deliver("three", { chat_id: "1" }),
    ]);
    expect(h.queued.map((q) => q.text.split("\n")[1])).toEqual(["one", "two", "three"]);
  });

  test("一条失败不阻塞后面的", async () => {
    let n = 0;
    const queued: string[] = [];
    const sink = new CodexQueueSink({
      source: "claudestra",
      getSessionId: () => A,
      heldThreadIds: async () => { if (n++ === 0) throw new Error("lsof died"); return [A]; },
      onSwitch: () => {},
      queue: async (_s, t) => { queued.push(t); return { ok: true, out: "", err: "" }; },
      notify: async () => {},
    });
    const [r1, r2] = await Promise.all([sink.deliver("a", {}), sink.deliver("b", {})]);
    expect(r1.ok).toBe(false); // 查活失败按离线处理
    expect(r2.ok).toBe(true);
    expect(queued.length).toBe(1);
  });
});

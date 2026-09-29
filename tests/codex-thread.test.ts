import { describe, expect, test } from "bun:test";
import {
  AMBIGUOUS_NOTICE,
  CodexQueueSink,
  OFFLINE_NOTICE,
  ROTATED_NOTICE,
  codexReplyHint,
  queueFailureNotice,
  codexParentGone,
  isPidAlive,
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
  test("属性值转义，非法键丢弃，source / reply_via 不被 meta 覆盖", () => {
    const w = wrapChannelContent("x", { user: 'a"<b>', "bad key": "v", source: "evil", reply_via: "evil" }, "claudestra");
    expect(w).toBe('<channel source="claudestra" user="a&quot;&lt;b&gt;">\nx\n</channel>');
  });
  test("reply_via（developer_instructions 不随 resume 生效的兜底）不影响解包出原文", () => {
    // meta 与生产同形：bridge 给 Web 用户的 meta 带 api="true"（bridge.ts deliver 组 meta 处），历史只对带注入属性的剥头
    const w = wrapChannelContent("[🌐 来自 Web]\n\n正文 <b>&", { chat_id: "api:t", user: "web", api: "true" }, "claudestra", codexReplyHint("claudestra"));
    expect(w).toContain(' reply_via="mcp__claudestra__reply(chat_id)；纯文本输出不会送达">');
    expect(unwrapChannelMessage(w)).toEqual({ text: "正文 <b>&", from: "web" });
  });
});

test("codexQueueArgs", () => {
  expect(codexQueueArgs("/c", A, "hi")).toEqual(["/c", "queue", "--thread", A, "--message", "hi"]);
});

/** bridge：不给 = 没接 undelivered 依赖；true / false = bridge 认没认出这条；"throw" = bridge 请求失败 */
function harness(initial: { sid?: string; held: string[][]; queueOk?: boolean; queueDelayMs?: number[]; bridge?: boolean | "throw" }) {
  let sid = initial.sid;
  let heldCall = 0;
  const queued: Array<{ sid: string; text: string }> = [];
  const notices: Array<{ chatId?: string; text: string }> = [];
  const switches: string[] = [];
  const undelivered: Array<{ messageId: string; notice: string }> = [];
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
    ...(initial.bridge === undefined ? {} : {
      undelivered: async (messageId: string, notice: string) => {
        undelivered.push({ messageId, notice });
        if (initial.bridge === "throw") throw new Error("ws down");
        return initial.bridge === true;
      },
    }),
  });
  return { sink, queued, notices, switches, sid: () => sid, undelivered };
}

describe("CodexQueueSink", () => {
  test("在线：包装后投到已知线程", async () => {
    const h = harness({ sid: A, held: [[A]] });
    expect(await h.sink.deliver("hi", { chat_id: "123", user: "u" })).toEqual({ ok: true });
    expect(h.queued).toEqual([{
      sid: A,
      text: '<channel source="claudestra" chat_id="123" user="u" reply_via="mcp__claudestra__reply(chat_id)；纯文本输出不会送达">\nhi\n</channel>',
    }]);
    expect(unwrapChannelMessage(h.queued[0].text)).toEqual({ text: "hi", from: "u" });
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
    expect(h.notices).toEqual([{ chatId: "1", text: AMBIGUOUS_NOTICE }]);
    expect(AMBIGUOUS_NOTICE).not.toContain("不在线");
  });

  test("/new 后新线程还没有 rollout：给出「先在终端发一条」的指引，而不是原样甩 stderr", async () => {
    expect(queueFailureNotice("Error: no rollout found for thread 01a0")).toBe(ROTATED_NOTICE);
    expect(queueFailureNotice("Error: boom")).toBe("⚠️ 消息投递到 Codex 失败：Error: boom");
  });

  test("queue 失败：报给发消息的人，不静默", async () => {
    const h = harness({ sid: A, held: [[A]], queueOk: false });
    const r = await h.sink.deliver("hi", { chat_id: "1" });
    expect(r).toEqual({ ok: false, error: "Error: boom" });
    expect(h.notices[0].text).toContain("Error: boom");
  });

  test("投不进去交给 bridge 按 messageId 了结（只结这一条，T52 #204 P1）：bridge 认出了就不再自己 reply（P2 不报两遍）", async () => {
    const off = harness({ sid: A, held: [[]], bridge: true });
    await off.sink.deliver("hi", { chat_id: "api:t", message_id: "m1" });
    expect(off.undelivered).toEqual([{ messageId: "m1", notice: OFFLINE_NOTICE }]);
    expect(off.notices).toEqual([]);
    const amb = harness({ sid: undefined, held: [[A, B]], bridge: true });
    await amb.sink.deliver("hi", { chat_id: "1", message_id: "m2" });
    expect(amb.undelivered).toEqual([{ messageId: "m2", notice: AMBIGUOUS_NOTICE }]);
    const q = harness({ sid: A, held: [[A]], queueOk: false, bridge: true });
    await q.sink.deliver("hi", { chat_id: "1", message_id: "m3" });
    expect(q.undelivered).toEqual([{ messageId: "m3", notice: "⚠️ 消息投递到 Codex 失败：Error: boom" }]);
    expect(q.notices).toEqual([]);
  });

  test("bridge 认不出这条 / 请求失败 / 没有 message_id：自己走 reply 说（never silent）", async () => {
    for (const bridge of [false, "throw"] as const) {
      const h = harness({ sid: A, held: [[A]], queueOk: false, bridge });
      await h.sink.deliver("hi", { chat_id: "1", message_id: "m4" });
      expect(h.undelivered).toHaveLength(1);
      expect(h.notices).toEqual([{ chatId: "1", text: "⚠️ 消息投递到 Codex 失败：Error: boom" }]);
    }
    const noId = harness({ sid: A, held: [[]], bridge: true });
    await noId.sink.deliver("hi", { chat_id: "1" });
    expect(noId.undelivered).toEqual([]);
    expect(noId.notices).toEqual([{ chatId: "1", text: OFFLINE_NOTICE }]);
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

describe("codexParentGone", () => {
  const alive = (set: number[]) => (pid: number) => set.includes(pid);
  test("被过继（ppid 变了）或父进程查无此人 → 已退出", () => {
    expect(codexParentGone(500, 500, alive([500]))).toBe(false);
    expect(codexParentGone(500, 1, alive([500]))).toBe(true);
    expect(codexParentGone(500, 500, alive([]))).toBe(true);
  });
  test("起来时就挂在 init 下：没有可盯的父进程，不因此退出", () => {
    expect(codexParentGone(1, 1, alive([]))).toBe(false);
  });
  test("isPidAlive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

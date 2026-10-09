// 自研 Codex 适配器的投递对账（I14）：带输入的请求拿不到可信结果时，只能证明「已投递」；查不到一律结果不明、不重排、不续跑。
// 每例都按 clientUserMessageId 统计假 app-server 收到这条输入的次数。用例名前缀是设计里的 R 编号。
import { describe, expect, test } from "bun:test";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { AcpTurnLoop } from "../src/lib/acp/turn.ts";
import type { AcpFailure } from "../src/lib/acp/failures.ts";
import { harness, tick, until, type Rec } from "./helpers/codex-fake-app.ts";

type H = ReturnType<typeof harness>;
const startedNote = (h: H, t: string) => ({ method: "turn/started", params: { threadId: h.f.thread, turn: { id: t, items: [], status: "inProgress" } } });
const onlyInput = (h: H) => [...h.f.inputs.values()];

/** turn/start：app-server 收下并跑完了，但回包按 delay 迟到（undefined = 永远不回）；consume=false 时连 userMessage 都不报 */
function lateStart(h: H, o: { delay?: number; consume?: boolean } = {}) {
  h.f.on("turn/start", (p, id) => {
    const t = h.f.nextTurn();
    h.f.feed(startedNote(h, t));
    if (o.consume !== false) h.f.consume(t, p.clientUserMessageId, "hi");
    h.f.complete(t);
    if (o.delay !== undefined) setTimeout(() => h.f.reply(id, { turn: { id: t, items: [], status: "inProgress" } }), o.delay);
    return undefined;
  });
}

describe("prompt（turn/start）", () => {
  test("R27 已执行、确认迟到（超过时限）：实时记录找到 clientId，接管那一轮照常收尾；不失败、不重发", async () => {
    const h = harness();
    await h.open();
    lateStart(h, { delay: 300 });
    expect(await h.session.prompt("hi")).toEqual({ kind: "done" });
    await tick(320);
    expect(onlyInput(h)).toEqual([1]);
    expect(h.causes).toEqual([]);
    expect(h.statuses()).toEqual(["active", "idle"]);
  });

  test("R28 确认丢失、对账查不到：prompt 结果不明（deliveryUnknown、不可重试），走 I12；宿主不续跑、不重发", async () => {
    const h = harness();
    await h.open();
    lateStart(h, { consume: false });
    const cards: AcpFailure[] = [];
    const loop = new AcpTurnLoop({ prompt: (t) => h.session.prompt(t), log: () => {}, reportStop: async () => ({}), onFailure: (f) => void cards.push(f) });
    loop.submit("hi");
    await until(() => cards.length === 1, "出卡", 3_000);
    expect(cards[0]).toMatchObject({ kind: "error", retry: false, deliveryUnknown: true });
    expect(cards[0]!.message).toContain("已停止本地执行");
    expect(h.causes[0]).toMatchObject({ kind: "unknown" });
    await tick(50);
    expect(onlyInput(h)).toEqual([1]);
    expect(h.f.calls("turn/start")).toHaveLength(1);
  });

  test("R28 对账请求本身不回：预算用完按查不到，结果不明", async () => {
    const h = harness();
    await h.open();
    lateStart(h, { consume: false });
    h.f.on("thread/items/list", () => undefined);
    const r = await h.session.prompt("hi");
    expect(r).toMatchObject({ kind: "failed", failure: { deliveryUnknown: true } });
    expect(onlyInput(h)).toEqual([1]);
  });

  test("R32 已入队、之后才回内部错误：不在白名单里，转对账；找到了就接管，不重发、不出卡", async () => {
    const h = harness();
    await h.open();
    h.f.on("turn/start", (p, id) => {
      const t = h.f.nextTurn();
      h.f.feed(startedNote(h, t));
      h.f.consume(t, p.clientUserMessageId);
      h.f.fail(id, -32603, "internal error after enqueue");
      setTimeout(() => h.f.complete(t), 20);
      return undefined;
    });
    expect(await h.session.prompt("hi")).toEqual({ kind: "done" });
    expect(onlyInput(h)).toEqual([1]);
    expect(h.causes).toEqual([]);
  });

  test("R31 确认丢失、记录排在第 51 项以后：第 51–150 项翻页找到，150 项以后查不到判结果不明；都只收到 1 次", async () => {
    for (const [pos, found] of [[60, true], [160, false]] as const) {
      const h = harness();
      await h.open();
      let clientId = "";
      h.f.on("turn/start", (p) => void (clientId = p.clientUserMessageId));
      h.f.on("thread/items/list", (p) => {
        const all: Rec[] = Array.from({ length: 200 }, (_, i) => ({ turnId: `old${i}`, item: { type: "agentMessage", id: `a${i}`, text: "x" } }));
        all[pos] = { turnId: "Tx", item: { type: "userMessage", id: "u", clientId, content: [] } };
        const from = p.cursor ? Number(p.cursor) : 0;
        return { data: all.slice(from, from + p.limit), nextCursor: from + p.limit < all.length ? String(from + p.limit) : null };
      });
      const r = h.session.prompt("hi");
      if (found) {
        await until(() => h.statuses().includes("active"), "接管后发 active", 3_000);
        h.f.complete("Tx");
        expect(await r).toEqual({ kind: "done" });
      } else expect(await r).toMatchObject({ kind: "failed", failure: { deliveryUnknown: true } });
      expect(h.f.calls("thread/items/list").length).toBe(found ? 2 : 3);
      expect(h.f.calls("thread/items/list")[0]).toMatchObject({ sortDirection: "desc", limit: 50, cursor: null });
      expect(onlyInput(h)).toEqual([1]);
    }
  });

  test("R43 新线程第一轮落盘前 items/list 回 -32601：按暂时查不到在预算内重试，之后查到就接管", async () => {
    const h = harness();
    await h.open();
    let calls = 0;
    let clientId = "";
    h.f.on("turn/start", (p) => void (clientId = p.clientUserMessageId));
    h.f.on("thread/items/list", (_p, id) => {
      if (++calls < 3) return void queueMicrotask(() => h.f.fail(id, -32601, "thread/items/list is not supported yet"));
      return { data: [{ turnId: "Tn", item: { type: "userMessage", id: "u", clientId, content: [] } }], nextCursor: null };
    });
    const r = h.session.prompt("hi");
    await until(() => h.statuses().includes("active"), "接管", 3_000);
    h.f.complete("Tn");
    expect(await r).toEqual({ kind: "done" });
    expect(calls).toBe(3);
  });
});

describe("steer（turn/steer）", () => {
  async function running(h: H) {
    await h.open();
    h.f.on("turn/start", (_p, id) => {
      h.f.turn = "R1";
      h.f.feed({ id, result: { turn: { id: "R1", items: [], status: "inProgress" } } }, startedNote(h, "R1"));
      return undefined;
    });
    const p = h.session.prompt("first");
    await until(() => h.statuses().includes("active"), "第一轮在跑");
    return { p }; // 包一层：async 函数直接 return promise 会被 await 拆开，等到这一轮结束
  }

  test("R29 R42(b) 已执行、确认丢失：实时记录里见过这个 clientId → injected，不重排", async () => {
    const h = harness();
    const { p } = await running(h);
    h.f.on("turn/steer", (q) => void h.f.consume("R1", q.clientUserMessageId, "插话"));
    expect(await h.session.steer("插话")).toEqual({ outcome: "injected" });
    expect(onlyInput(h)).toEqual([1, 1]);
    h.f.complete("R1");
    expect(await p).toEqual({ kind: "done" });
  });

  test("R29 R42(a) 确认丢失、目标回合已收尾、两边都查不到：结果不明（不是 failed），宿主不改回 prompt、出 1 张卡", async () => {
    const h = harness();
    await running(h);
    const cards: AcpFailure[] = [];
    const loop = new AcpTurnLoop({ prompt: (t) => h.session.prompt(t), steer: (t) => h.session.steer(t), log: () => {}, reportStop: async () => ({}), onFailure: (f) => void cards.push(f) });
    (loop as any).pumping = true; // 宿主这边认为有一轮在跑：消息走 steer
    h.f.on("turn/steer", () => void h.f.complete("R1"));
    expect(await loop.submit("插话")).toBe("unknown");
    expect(cards).toEqual([expect.objectContaining({ deliveryUnknown: true, retry: false })]);
    expect(cards[0]!.message).toContain("插话");
    await tick(30);
    expect(h.f.calls("turn/start")).toHaveLength(1);
    expect(h.causes[0]).toMatchObject({ kind: "unknown" });
  });

  test("R42(c) 对账期间 items/list 一直回 -32601：结果不明，不重排", async () => {
    const h = harness();
    await running(h);
    h.f.on("turn/steer", () => undefined);
    h.f.on("thread/items/list", (_p, id) => void queueMicrotask(() => h.f.fail(id, -32601, "thread/items/list is not supported yet")));
    expect(await h.session.steer("插话")).toMatchObject({ outcome: "deliveredUnknown" });
    expect(h.f.calls("turn/start")).toHaveLength(1);
  });
});

describe("compact（thread/compact/start）", () => {
  const compactionItem = (h: H, t: string, method: string) => ({ method, params: { threadId: h.f.thread, turnId: t, item: { type: "contextCompaction", id: `cc-${t}` } } });

  test("R33(a) 确认丢失但压缩其实已经开始：接管那一轮，只出一个边界，/compact 在 turn/completed 之后才回", async () => {
    const h = harness();
    await h.open();
    h.f.on("thread/compact/start", () => {
      h.f.feed(startedNote(h, "C1"), compactionItem(h, "C1", "item/started"), compactionItem(h, "C1", "item/completed"));
      setTimeout(() => h.f.complete("C1"), 250);
      return undefined;
    });
    expect(await h.session.prompt("/compact")).toEqual({ kind: "done" });
    const tr = createAcpTranslator(() => "t", { from: "compaction-update", trigger: () => "manual" });
    const boundaries = h.updates.flatMap((u) => tr.push(u)).filter((e) => e.subtype === "compact_boundary");
    expect(boundaries).toHaveLength(1);
    expect(h.f.calls("thread/compact/start")).toHaveLength(1);
  });

  test("R33(b) 确认丢失、查不到：/compact 那一轮结果不明（写明压缩可能已经开始），不自动重发", async () => {
    const h = harness();
    await h.open();
    h.f.on("thread/compact/start", () => undefined);
    const r = await h.session.prompt("/compact");
    expect(r).toMatchObject({ kind: "failed", failure: { deliveryUnknown: true, retry: false } });
    expect(r.kind === "failed" && r.failure.message).toContain("压缩可能已经开始");
    expect(h.f.calls("thread/compact/start")).toHaveLength(1);
  });

  test("B27 正常压缩：{} 之后认第一个 turn/started，收尾只看 turn/completed；被打断补 cancelled 进度、不出边界", async () => {
    const h = harness();
    await h.open();
    h.f.on("thread/compact/start", () => {
      setTimeout(() => (h.f.feed(startedNote(h, "C2"), compactionItem(h, "C2", "item/started")), h.f.complete("C2", "interrupted")), 5);
      return {};
    });
    expect(await h.session.prompt("/compact")).toEqual({ kind: "cancelled" });
    expect(h.updates.filter((u) => u.sessionUpdate === "compaction_update").map((u) => u.status)).toEqual(["in_progress", "cancelled"]);
  });
});

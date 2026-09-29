import { describe, expect, test } from "bun:test";
import { FADE_MS, GUARD_MS, activeAnswered, clearAnswered, cooldownView, markAnswered, subscribeAnswered } from "../web/features/asks/answer-cooldown";
import { fadeSlot, withFade } from "../web/features/asks/ask-fade";
import { applyPending, groupAsks, type PendingAnswer, type WebAsk } from "../web/features/asks/asks-model";

// 09-29：owner 只记得点了一下，两张按钮字相同的卡（#209、T50）隔 1.95 秒先后被答掉；客户端日志这段没有 [tap-synth]，
// 是第一张乐观移走、下一张顶到原位，看着像没点上，又点了一下。改成答完先原位淡出，再短暂不收点击
describe("答完一张：先淡出，再短暂防连点，然后收掉", () => {
  test("fading → guard → null，每次切换都通知订阅方", async () => {
    let n = 0;
    const off = subscribeAnswered(() => n++);
    markAnswered("ask_a");
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "fading" });
    await Bun.sleep(FADE_MS + 30);
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "guard" });
    await Bun.sleep(GUARD_MS + 30);
    expect(activeAnswered()).toBeNull();
    expect(n).toBe(3);
    off();
  });

  test("淡出期间又答了一张：以后一张为准，前一张的计时作废", async () => {
    markAnswered("ask_a");
    await Bun.sleep(FADE_MS - 100);
    markAnswered("ask_b");
    await Bun.sleep(150);
    expect(activeAnswered()).toEqual({ id: "ask_b", phase: "fading" });
    await Bun.sleep(FADE_MS + GUARD_MS);
    expect(activeAnswered()).toBeNull();
  });
});

// 同家审查 P2-1 / P2-4：作答几毫秒就失败时，卡先淡到透明、失败原因跟着淡没，450ms 后才弹回来
describe("抽屉怎么用这一笔（cooldownView）", () => {
  const asks = [{ id: "ask_a", state: "answered" }, { id: "ask_b", state: "open" }];
  test("没有过渡：不淡出、不挡", () => {
    expect(cooldownView(null, asks)).toEqual({ fadingId: null, guard: false });
  });
  test("淡出中：这张留在原位淡出，别的开着的卡暂不收点击", () => {
    expect(cooldownView({ id: "ask_a", phase: "fading" }, asks)).toEqual({ fadingId: "ask_a", guard: true });
    expect(cooldownView({ id: "ask_a", phase: "guard" }, asks)).toEqual({ fadingId: null, guard: true });
  });
  test("store 里这张又是 open（作答失败回滚）：不淡出、不挡，失败原因照常看得见", () => {
    const failed = [{ id: "ask_a", state: "open" }, { id: "ask_b", state: "open" }];
    expect(cooldownView({ id: "ask_a", phase: "fading" }, failed)).toEqual({ fadingId: null, guard: false });
  });
  test("clearAnswered：只清同一张，别的张的过渡不受影响", () => {
    markAnswered("ask_a");
    clearAnswered("ask_x");
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "fading" });
    clearAnswered("ask_a");
    expect(activeAnswered()).toBeNull();
  });
});

// T61（含 T56 终审 P2）：删卡；淡出期间这张钉在点下去时的位置，服务端撤掉 / 删掉它、上面插进更急的卡都不动
describe("删卡与淡出快照（ask-fade.ts、asks-model applyPending）", () => {
  const card = (id: string, over: Partial<WebAsk> = {}): WebAsk => ({
    id, project: "p", taskId: null, fromAgent: "agent-x", source: "reply", kind: "decide", blocking: null, urgency: "normal",
    title: id, context: "", body: "", options: [], allowText: true, kindHint: null, expiresAt: 9e12, state: "open", answer: null,
    createdAt: 1_000, updatedAt: 1_000, ...over,
  });
  const ids = (g: ReturnType<typeof groupAsks>) => ({ waiting: g.waiting.map((a) => a.id), recent: g.recent.map((a) => a.id) });

  test("快照记在点下去那一刻的位置；之后插进更急的卡、服务端把这一行撤了，它都还在原位", () => {
    const before = [card("a", { createdAt: 1 }), card("b", { createdAt: 2 }), card("c", { createdAt: 3 })];
    const slot = fadeSlot(before, before[1]!);
    expect([slot.section, slot.index]).toEqual(["waiting", 1]);
    const after = [card("urgent", { urgency: "urgent", createdAt: 9 }), before[0]!, card("b", { state: "cancelled", updatedAt: 5 }), before[2]!];
    expect(ids(withFade(groupAsks(after), slot))).toEqual({ waiting: ["urgent", "b", "a", "c"], recent: [] });
    expect(ids(withFade(groupAsks([before[0]!, before[2]!]), slot))).toEqual({ waiting: ["a", "b", "c"], recent: [] }); // 服务端删了这一行
  });

  test("快照只是画面：画的是点下去时那份（原来的状态），淡完（slot 清掉）就按实时的走", () => {
    const b = card("b");
    const g = withFade(groupAsks([card("b", { state: "cancelled" })]), fadeSlot([b], b));
    expect(g.waiting[0]).toBe(b);
    expect(ids(withFade(groupAsks([card("b", { state: "cancelled" })]), null))).toEqual({ waiting: [], recent: ["b"] });
  });

  test("乐观删卡：开着的、已结案的都立刻不进任何一组；服务端确认（列表里没了）才结清；失败回滚后照常显示", () => {
    const server = [card("a"), card("b", { state: "answered" })];
    const pending = new Map<string, PendingAnswer>([["a", { at: 1, inFlight: true, dismiss: true }], ["b", { at: 1, inFlight: true, dismiss: true }]]);
    const v = applyPending(server, pending, 2);
    expect(ids(groupAsks(v.asks))).toEqual({ waiting: [], recent: [] });
    expect(applyPending([card("b", { state: "answered" })], pending, 2).settled).toEqual(["a"]);
    expect(ids(groupAsks(applyPending(server, new Map(), 2).asks))).toEqual({ waiting: ["a"], recent: ["b"] });
  });

  test("删卡的淡出：store 里这张还是 open 但标了删掉，照常淡出；删卡失败回滚（没标）才停", () => {
    expect(cooldownView({ id: "a", phase: "fading" }, [{ id: "a", state: "open", extra: { dismissed: true } }]).fadingId).toBe("a");
    expect(cooldownView({ id: "a", phase: "fading" }, [{ id: "a", state: "open" }]).fadingId).toBeNull();
    expect(cooldownView({ id: "a", phase: "fading" }, []).fadingId).toBe("a"); // 已结案的删掉后列表里没了
  });
});

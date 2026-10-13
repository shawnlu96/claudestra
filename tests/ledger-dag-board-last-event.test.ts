/**
 * 子 DAG 节点的「最近一条事件 / 完成时刻」（SUBDAG2，lib/ledger-dag-board-last-event.ts）：纯函数，只吃这张卡的事件与节点三态。
 * 白名单之外的事件（调度记账、memory、step、观察类 note）一律跳过；文本折行、截 sha、按码点截断。
 */
import { describe, expect, test } from "bun:test";
import { nodeEventFacts } from "../src/lib/ledger-dag-board-last-event.js";
import type { EventKind, LedgerEvent } from "../src/lib/ledger-stages.js";

let seq = 0;
function ev(kind: EventKind, text: string, data: Record<string, unknown> = {}, actor = "agent-exec"): LedgerEvent {
  seq += 1;
  return { seq, ts: seq * 100, actor, project: "p", target: "T", kind, text, data, dedupKey: null };
}
const sched = (op: string, text = `${op} 记账`) => ev("scheduler", text, { op }, "scheduler");
const last = (events: LedgerEvent[]) => nodeEventFacts(events, "active").lastEvent;

describe("[验收线 1] 跳过", () => {
  test("以 scheduler settle / plan / pool_offer 结尾：取到前面那条 stage", () => {
    const stage = ev("stage", "复述过了，开工", { from: "restate", to: "build" }, "agent-pm");
    const events = [ev("note", "先看一眼规格"), stage, sched("settle"), sched("plan"), sched("pool_offer")];
    expect(last(events)).toEqual({ at: stage.ts, actor: "agent-pm", kind: "stage", text: "复述过了，开工" });
  });
  test("以调度记账结尾：取到前面那条手写 note（没有 data.op）", () => {
    const note = ev("note", "接口先按旧字段出");
    expect(last([ev("stage", "开工"), note, sched("settle"), sched("plan")])).toEqual({ at: note.ts, actor: "agent-exec", kind: "note", text: "接口先按旧字段出" });
  });
  test("memory、step 和空文本全部跳过", () => {
    const keep = ev("deliver", "交付 r1");
    const events = [keep, ev("memory", "检索到 3 条"), ev("step", "assign 写"), ev("review", ""), ev("note", "  \n "), ev("stage", "")];
    expect(last(events)).toMatchObject({ at: keep.ts, kind: "deliver" });
  });
  test("task / feature / meta 以及白名单外的 kind 跳过", () => {
    const keep = ev("verify", "线上核对通过");
    const events = [keep, ev("task", "改了标题"), ev("feature", "建 feature"), ev("meta", "改 pms"), ev("escalate", "升级给 PM"), ev("accept", "验收")];
    expect(last(events)).toMatchObject({ at: keep.ts, kind: "verify" });
  });
  test("白名单外的 note op（recovery_observe 等）和 scheduler op（session_retire 等）跳过", () => {
    const keep = ev("note", "审查员要补一条测试", { op: "review_ask" });
    const noise = [ev("note", "观察到恢复", { op: "recovery_observe" }), ev("note", "范围快照", { op: "deliver_scope" }), ev("note", "新 op", { op: "brand_new_op" }),
      sched("session_retire"), sched("memory_rank"), sched("brand_new_op")];
    expect(last([keep, ...noise])).toMatchObject({ at: keep.ts, kind: "note", text: "审查员要补一条测试" });
  });
  test("全是噪音 / 没有事件 / undefined：lastEvent 为 null", () => {
    expect(last([sched("settle"), ev("memory", "x"), ev("step", "y")])).toBeNull();
    expect(last([])).toBeNull();
    expect(nodeEventFacts(undefined, "active")).toEqual({ lastEvent: null, doneAt: null });
  });
});

describe("[验收线 1] 保留", () => {
  test("ask 和 decision 事件（提问类默认保留）", () => {
    const ask = ev("ask", "字段名用 lastEvent 还是 latest？", { askId: "a1" }, "agent-pm");
    expect(last([ev("stage", "开工"), ask, sched("settle")])).toEqual({ at: ask.ts, actor: "agent-pm", kind: "ask", text: "字段名用 lastEvent 还是 latest？" });
    const decision = ev("decision", "用 lastEvent", { askId: "a1" }, "owner");
    expect(last([ask, decision, sched("plan")])).toEqual({ at: decision.ts, actor: "owner", kind: "decision", text: "用 lastEvent" });
  });
  test.each(["stage", "deliver", "review", "verify", "deploy", "ask", "ask_cancel", "decision", "dispatch"] as const)("kind 白名单：%s", (kind) => {
    const e = ev(kind, "有话说", { op: "whatever" });
    expect(last([e, sched("settle")])).toMatchObject({ at: e.ts, kind });
  });
  test.each(["review_ask", "local_author", "lend_author_family", "supervise", "lock_yield_released", "refusal_owner_inform"])("note op 白名单：%s", (op) => {
    const e = ev("note", "有话说", { op });
    expect(last([e, sched("settle")])).toMatchObject({ at: e.ts, kind: "note" });
  });
  test.each(["merge_phase", "deploy_phase", "order_taken", "fallback_manual", "convergence_effect"])("scheduler op 白名单：%s", (op) => {
    const e = sched(op, "合并排到第 2 位");
    expect(last([ev("stage", "开工"), e, sched("settle")])).toEqual({ at: e.ts, actor: "scheduler", kind: "scheduler", text: "合并排到第 2 位" });
  });
  test("按 seq 取最后一条有信息的，不是第一条", () => {
    const b = ev("review", "第二轮：通过");
    expect(last([ev("deliver", "交付 r1"), ev("review", "第一轮：要改"), b])).toMatchObject({ at: b.ts, text: "第二轮：通过" });
  });
});

describe("[验收线 1] text 清理", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  test("40 位 sha 截成 12 位；更长的十六进制串（64 位摘要）不动", () => {
    expect(last([ev("deliver", `交付 head ${SHA}，基线 ${SHA.toUpperCase()}`)])!.text).toBe("交付 head 0123456789ab，基线 0123456789AB");
    const digest = "ab".repeat(32);
    expect(last([ev("note", `摘要 ${digest}`)])!.text).toBe(`摘要 ${digest}`);
  });
  test("130 字中文截到 120 字加 …；刚好 120 字不加", () => {
    const text = last([ev("note", "字".repeat(130))])!.text;
    expect(text).toBe(`${"字".repeat(120)}…`);
    expect(Array.from(text)).toHaveLength(121);
    expect(last([ev("note", "字".repeat(120))])!.text).toBe("字".repeat(120));
  });
  test("emoji 不被切开：按码点数，截断处不留半个代理对", () => {
    const text = last([ev("note", `${"字".repeat(119)}😀😀😀`)])!.text;
    expect(text).toBe(`${"字".repeat(119)}😀…`);
    expect(Array.from(text)).toHaveLength(121);
    expect(text.isWellFormed()).toBe(true);
    expect(last([ev("note", "😀".repeat(120))])!.text).toBe("😀".repeat(120));
  });
  test("换行折成空格，首尾空白去掉", () => {
    expect(last([ev("note", "  第一行\n第二行\r\n\n  第三行\n")])!.text).toBe("第一行 第二行 第三行");
  });
  test("actor、kind 原样", () => {
    expect(last([ev("dispatch", "派审查员", {}, "  Agent-PM ")])).toMatchObject({ actor: "  Agent-PM ", kind: "dispatch" });
  });
});

describe("[验收线 1] 按 phase 取值", () => {
  const events = () => [ev("stage", "开工", { to: "build" }), ev("note", "写完了"), ev("stage", "", { to: "done" }), sched("settle"), ev("note", "收尾备注")];
  test("idle：lastEvent 与 doneAt 都是 null", () => {
    expect(nodeEventFacts(events(), "idle")).toEqual({ lastEvent: null, doneAt: null });
  });
  test("done：doneAt = 最后一条 stage 的 ts（文本为空也算），lastEvent 为 null", () => {
    const list = events();
    expect(nodeEventFacts(list, "done")).toEqual({ lastEvent: null, doneAt: list[2]!.ts });
  });
  test("done 但没有 stage 事件（建卡时直接是 done）：doneAt 为 null", () => {
    expect(nodeEventFacts([ev("note", "老卡")], "done")).toEqual({ lastEvent: null, doneAt: null });
  });
  test("active：有 lastEvent，doneAt 为 null", () => {
    const list = events();
    expect(nodeEventFacts(list, "active")).toEqual({ lastEvent: { at: list[4]!.ts, actor: "agent-exec", kind: "note", text: "收尾备注" }, doneAt: null });
  });
});

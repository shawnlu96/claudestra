/**
 * human 节点的纯规则（lib/human-node.ts）：什么时候开 assigned ask、幂等键与 attempt、v3.2 交付门、给 PM 的固定模板不带人写的字。
 */
import { describe, expect, test } from "bun:test";
import { askPlanFor, assignDedupKey, attemptOf, checkHumanDeliver, humanDeliverText, pmNotice, resultOfChoices, type HumanTaskView } from "../src/lib/human-node.js";

const task = (over: Partial<HumanTaskView> = {}): HumanTaskView => ({
  id: "T123", project: "p", title: "登录页改文案", stage: "build", round: 0, assigneeKind: "human", assignee: "local:guest:ab12", pm: "agent-pm",
  extra: { brief: "背景一。背景二。背景三。" }, ...over,
});

describe("开 assigned ask", () => {
  test("只在 human 节点进入 build / fix 时开；正文是任务号、标题和 PM 写的背景，卡片直接显示的背景是返工轮次与 brief", () => {
    const plan = askPlanFor(task(), 1)!;
    expect(plan).toMatchObject({ dedupKey: "assign:T123:0:1", assignee: "local:guest:ab12", title: "T123 登录页改文案", body: "T123 登录页改文案\n\n背景一。背景二。背景三。" });
    const ids = (plan.options as { buttons: { id: string }[] }[]).flatMap((r) => r.buttons.map((b) => b.id));
    expect(ids).toEqual(["assign_done", "assign_cant"]);
    expect(resultOfChoices(["[button:assign_done]"])).toBe("done");
    expect(resultOfChoices(["[button:assign_cant]"])).toBe("cant");
    expect(resultOfChoices(["[button:other]"])).toBeNull();
    expect(plan.context).toBe("背景一。背景二。背景三。");
    expect(askPlanFor(task({ stage: "fix", round: 2 }), 1)!).toMatchObject({ body: expect.stringContaining("第 2 轮返工"), context: "第 2 轮返工\n背景一。背景二。背景三。" });
    for (const stage of ["spec", "restate", "review", "merge", "done", "blocked"]) expect(askPlanFor(task({ stage }), 1)).toBeNull();
    expect(askPlanFor(task({ assigneeKind: "agent", assignee: "agent-x" }), 1)).toBeNull();
    expect(askPlanFor(task({ extra: {} }), 1)).toMatchObject({ body: "T123 登录页改文案", context: "" });
  });
  test("attempt = 1 + 本轮 assign_reopen 次数；别的轮、别的任务不算", () => {
    const ev = (target: string, round: number) => ({ kind: "assign_reopen", target, data: { round } });
    expect(attemptOf([], "T123", 0)).toBe(1);
    expect(attemptOf([ev("T123", 0), ev("T123", 0), ev("T123", 1), ev("T9", 0), { kind: "note", target: "T123", data: { round: 0 } }], "T123", 0)).toBe(3);
    expect(assignDedupKey("T123", 1, 2)).toBe("assign:T123:1:2");
  });
});

describe("v3.2 交付门", () => {
  const ask = { dedupKey: "assign:T123:0:1", kind: "assigned" };
  const me = { persons: ["local:guest:ab12", "local:guest:cd34"], isOwner: false };
  test("被指派的人（含合并后同一个人名下的设备）点完成 → 写交付并推到 review；做不了 → 不推", () => {
    expect(checkHumanDeliver(task(), ask, me, "done", 1)).toEqual({ ok: true, move: true });
    expect(checkHumanDeliver(task(), ask, { persons: ["local:guest:cd34", "local:guest:ab12"], isOwner: false }, "done", 1)).toEqual({ ok: true, move: true });
    expect(checkHumanDeliver(task(), ask, me, "cant", 1)).toEqual({ ok: true, move: false });
  });
  test("owner 可以代答；别的 guest 不行", () => {
    expect(checkHumanDeliver(task(), ask, { persons: ["local:owner:self"], isOwner: true }, "done", 1).ok).toBe(true);
    expect(checkHumanDeliver(task(), ask, { persons: ["local:guest:ffff"], isOwner: false }, "done", 1).ok).toBe(false);
  });
  test("过时的 ask（上一轮 / 上一次 attempt）、不是 assigned、任务已不在 build / fix、不是 human 节点：都拒", () => {
    expect(checkHumanDeliver(task({ round: 1, stage: "fix" }), ask, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task(), ask, me, "done", 2).ok).toBe(false);
    expect(checkHumanDeliver(task(), { ...ask, kind: "decide" }, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task({ stage: "review" }), ask, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task({ stage: "merge" }), ask, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task({ assigneeKind: "agent" }), ask, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task(), ask, { persons: ["local:guest:ffff"], isOwner: false }, "done", 1)).toMatchObject({ ok: false, code: "forbidden" });
    expect(checkHumanDeliver(task({ stage: "review" }), ask, me, "done", 1)).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("固定模板：不带人写的任何字", () => {
  test("deliver 的 text 与给 PM 的通知", () => {
    expect(humanDeliverText("T123", "done")).toBe("T123 人工交付：完成");
    expect(humanDeliverText("T123", "cant")).toBe("T123 人工交付：做不了");
    expect(pmNotice(task(), "done")).toBe("[台账] T123 指派给 local:guest:ab12 的事项已完成，已推到 review。");
    expect(pmNotice(task(), "cant")).toBe("[台账] T123 指派给 local:guest:ab12 的事项做不了，原因记在台账里。");
  });
});

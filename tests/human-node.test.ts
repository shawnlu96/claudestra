/**
 * human 节点的纯规则（lib/human-node.ts）：什么时候开 assigned ask、幂等键与开单序号、v3.2 交付门、给 PM 的固定模板不带人写的字。
 */
import { describe, expect, test } from "bun:test";
import { askPlanFor, assignDedupKey, assignSeqOf, checkHumanDeliver, humanDeliverText, isHumanNodeAsk, pmNotice, resultOfChoices, type HumanTaskView } from "../src/lib/human-node.js";

const task = (over: Partial<HumanTaskView> = {}): HumanTaskView => ({
  id: "T123", project: "p", title: "登录页改文案", stage: "build", round: 0, assigneeKind: "human", assignee: "local:guest:ab12", pm: "agent-pm",
  extra: { brief: "背景一。背景二。背景三。" }, ...over,
});

describe("开 assigned ask", () => {
  test("只在 human 节点进入 build / fix 时开；标题是任务号加标题，背景是返工轮次与 PM 写的 brief", () => {
    const plan = askPlanFor(task(), 1)!;
    expect(plan).toMatchObject({ dedupKey: "assign:T123:0:1:local:guest:ab12", assignee: "local:guest:ab12", title: "T123 登录页改文案", context: "背景一。背景二。背景三。" });
    const ids = (plan.options as { buttons: { id: string }[] }[]).flatMap((r) => r.buttons.map((b) => b.id));
    expect(ids).toEqual(["assign_done", "assign_cant"]);
    expect(resultOfChoices(["[button:assign_done]"])).toBe("done");
    expect(resultOfChoices(["[button:assign_cant]"])).toBe("cant");
    expect(resultOfChoices(["[button:other]"])).toBeNull();
    expect(askPlanFor(task({ stage: "fix", round: 2 }), 1)!.context).toBe("第 2 轮返工\n背景一。背景二。背景三。");
    for (const stage of ["spec", "restate", "review", "merge", "done", "blocked"]) expect(askPlanFor(task({ stage }), 1)).toBeNull();
    expect(askPlanFor(task({ assigneeKind: "agent", assignee: "agent-x" }), 1)).toBeNull();
    expect(askPlanFor(task({ extra: {} }), 1)!.context).toBe("");
  });
  test("开单序号：进 build / fix、PM 重开、改派各加一；改成同一个人、别的阶段、别的任务不算", () => {
    const stage = (to: string, target = "T123") => ({ kind: "stage", target, data: { to } });
    const set = (patch: Record<string, unknown>) => ({ kind: "task", target: "T123", data: { op: "set", patch } });
    const born = { kind: "task", target: "T123", data: { op: "new", patch: { stage: "spec", assignee: "local:guest:aa" } } };
    expect(assignSeqOf([born], "T123")).toBe(0);
    const build = [born, stage("restate"), stage("build")];
    expect(assignSeqOf(build, "T123")).toBe(1);
    expect(assignSeqOf([...build, stage("blocked"), stage("build")], "T123")).toBe(2);
    expect(assignSeqOf([...build, { kind: "assign_reopen", target: "T123", data: {} }], "T123")).toBe(2);
    expect(assignSeqOf([...build, set({ assignee: "local:guest:bb" }), set({ assignee: "local:guest:aa" })], "T123")).toBe(3);
    expect(assignSeqOf([...build, set({ assignee: "local:guest:aa" }), set({ title: "改个标题" }), stage("build", "T9")], "T123")).toBe(1);
    expect(assignSeqOf([{ kind: "task", target: "T123", data: { op: "new", patch: { stage: "build" } } }], "T123")).toBe(1);
    expect(assignDedupKey("T123", 1, 2, "local:guest:aa")).toBe("assign:T123:1:2:local:guest:aa");
  });
  test("只有 human 节点开的指派才归它管", () => {
    expect(isHumanNodeAsk({ kind: "assigned", createdBy: "system:human-node" })).toBe(true);
    expect(isHumanNodeAsk({ kind: "assigned", createdBy: "owner:self" })).toBe(false);
    expect(isHumanNodeAsk({ kind: "decide", createdBy: "system:human-node" })).toBe(false);
  });
});

describe("v3.2 交付门", () => {
  const ask = { dedupKey: "assign:T123:0:1:local:guest:ab12", kind: "assigned" };
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
  test("过时的 ask（上一轮 / 序号变了 / 改派了）、不是 assigned、任务已不在 build / fix、不是 human 节点：都拒", () => {
    expect(checkHumanDeliver(task({ round: 1, stage: "fix" }), ask, me, "done", 1).ok).toBe(false);
    expect(checkHumanDeliver(task(), ask, me, "done", 2).ok).toBe(false);
    expect(checkHumanDeliver(task({ assignee: "local:guest:cd34" }), ask, me, "done", 1)).toMatchObject({ ok: false, code: "conflict" });
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

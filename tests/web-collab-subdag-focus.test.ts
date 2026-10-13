/** 子 DAG「进行中优先」的纯模型（web/features/collab/dag/subdag-focus.ts，team-project-SUBDAG1）：分态、排序、接下来分组、已完成、顶栏 */
import { describe, expect, test } from "bun:test";
import { STEP_SLOTS } from "../web/features/collab/dag/dag-steps";
import { subdagFocus } from "../web/features/collab/dag/subdag-focus";
import { feature, MAIN_NOW, mainlineFeature, mainlineWork, node, teamRow, teamWorkBoard, workBoard, workRow } from "./web-collab-dag-fixture";

const NOW = MAIN_NOW;
const label = (key: string) => STEP_SLOTS.find((s) => s.key === key)!.label;
const local = (extra: Parameters<typeof workBoard>[0] = {}) => ({ kind: "local" as const, board: workBoard({ now: NOW, ...extra }) });
const keys = (xs: { nodeKey: string }[]) => xs.map((x) => x.nodeKey);

describe("主线形状 [验收线 2]", () => {
  const m = subdagFocus(mainlineFeature(), { kind: "local", board: mainlineWork() }, NOW);

  test("进行中顺序：owner → 在等（等得久在前）→ 超常规 → 在干活（解锁多在前）", () => {
    expect(keys(m.active)).toEqual(["a-owner", "a-pool", "a-ci", "a-mq", "a-over", "a-w1", "a-peer", "a-w2"]);
    expect(m.active.map((c) => c.state)).toEqual(["owner", "waiting", "waiting", "waiting", "over", "working", "working", "working"]);
    expect(m.active.map((c) => c.unlock).slice(5)).toEqual([7, 4, 0]);
  });

  test("顶栏：在干活 4、在等 4、没开始 16、已完成 30；近 24 小时 12；机器按进行中卡计", () => {
    expect(m.head).toEqual({ total: 54, done: 30, active: 4, waiting: 4, idle: 16, done24h: 12, machines: { local: 7, Sekai: 1 } });
  });

  test("peer 卡认出 claude 与机器名；本机行的字段原样带上", () => {
    const peer = m.active.find((c) => c.nodeKey === "a-peer")!;
    expect([peer.family, peer.machine, peer.who]).toEqual(["claude", "Sekai", "peer:Sekai · claude"]);
    const over = m.active.find((c) => c.nodeKey === "a-over")!;
    expect([over.overMinutes, over.normalMinutes, over.since]).toEqual([35, 30, NOW - 65 * 60_000]);
    expect(m.active.find((c) => c.nodeKey === "a-w1")!.family).toBeNull();
    expect(m.active.find((c) => c.nodeKey === "a-ci")!.reason).toBe("等 CI");
  });

  test("别的 feature 的同名 nodeKey 行不认", () => {
    expect(m.active.find((c) => c.nodeKey === "a-w1")!.machine).toBe("local");
  });

  test("接下来：可开工 0、下一批 7、更远 9 [验收线 3]", () => {
    expect(m.next.ready).toEqual([]);
    expect(keys(m.next.oneHop)).toEqual(["n1", "n4", "n2", "n3", "n5", "n7", "n6"]);
    expect(m.next.oneHop.find((r) => r.nodeKey === "n6")!.waitsOn).toEqual(["a-ci", "a-pool"]);
    expect(m.next.oneHop.find((r) => r.nodeKey === "n7")!.waitsOn).toEqual(["a-mq"]);
    expect(m.next.oneHop.every((r) => r.hops === 1)).toBe(true);
    const hops = Object.fromEntries(m.next.far.map((r) => [r.nodeKey, r.hops]));
    expect(hops).toEqual({ f1: 2, f2: 3, f3: 2, f4: 2, f5: 3, f6: 4, f7: 2, f8: 2, f9: 2 });
    expect(m.next.far.find((r) => r.nodeKey === "f8")!.waitsOn).toEqual(["gone"]);
    expect(m.next.oneHop[0]!.estimate).toBe("n1 1h");
  });

  test("已完成按 doneAt 降序，cancelled 标出", () => {
    expect(m.done.length).toBe(30);
    expect(m.done[0]!.nodeKey).toBe("d01");
    expect(m.done.at(-1)!.nodeKey).toBe("d30");
    expect(m.done.filter((d) => d.cancelled).map((d) => d.nodeKey)).toEqual(["d26"]);
    expect(m.done[0]!.round).toBe(2);
    expect(m.autoOpenDone).toBe(false);
  });
});

describe("分态 [验收线 8]", () => {
  test("step 为 merge 的本机行、code 为 ci 的本机行都是 waiting（即使在 working 里）", () => {
    const f = feature("F1", [node("A", "active"), node("B", "active"), node("C", "active")]);
    const m = subdagFocus(f, local({ working: [workRow("A", { step: "merge" }), workRow("B", { code: "ci" }), workRow("C", { step: "deploy", overMinutes: 9 })] }), NOW);
    expect(Object.fromEntries(m.active.map((c) => [c.nodeKey, c.state]))).toEqual({ A: "waiting", B: "waiting", C: "waiting" });
    expect(m.active.find((c) => c.nodeKey === "C")!.step).toEqual({ label: "部署", round: null });
  });

  test("等 owner 的提问算 owner；等 PM 的提问算 waiting", () => {
    const f = feature("F1", [node("A", "active"), node("B", "active")]);
    const m = subdagFocus(f, local({ waiting: [workRow("A", { code: "ask", reason: "等 owner" }), workRow("B", { code: "ask", reason: "等 PM 答复：x" })] }), NOW);
    expect(m.active.map((c) => [c.nodeKey, c.state])).toEqual([["A", "owner"], ["B", "waiting"]]);
  });

  test("missing 节点算 waiting，原因写卡不在本项目", () => {
    const f = feature("F1", [node("A", "active", [], { missing: true, status: null })]);
    const c = subdagFocus(f, null, NOW).active[0]!;
    expect([c.state, c.reason, c.missing]).toEqual(["waiting", "卡不在本项目", true]);
  });

  test("团队行：在 board.waiting 里算 waiting；在 working 里算 working（没有超时）", () => {
    const f = feature("F1", [node("A", "active"), node("B", "active")]);
    const tb = teamWorkBoard({ waiting: [teamRow("A", { stage: "blocked" })], working: [teamRow("B", { who: "codex-7", machine: "Ann" })] });
    const m = subdagFocus(f, { kind: "team", board: tb }, NOW);
    expect(m.active.map((c) => [c.nodeKey, c.state])).toEqual([["A", "waiting"], ["B", "working"]]);
    expect(m.active[1]!.family).toBe("codex");
  });

  test("在干活同解锁数时按已耗时间降序，再同就按 nodeKey", () => {
    const f = feature("F1", [node("B", "active"), node("A", "active"), node("C", "active")]);
    const m = subdagFocus(f, local({ working: [workRow("A", { since: NOW - 1000 }), workRow("B", { since: NOW - 9000 }), workRow("C", { since: NOW - 1000 })] }), NOW);
    expect(keys(m.active)).toEqual(["B", "A", "C"]);
  });
});

describe("步骤与轮次", () => {
  test("label 取六格格名、round 取轮次；roundUnknown 时 round 为 null", () => {
    const sl = { active: { step: "final_review", round: 3 }, steps: [
      { step: "write", round: 1, state: "done" }, { step: "review", round: 1, state: "done" }, { step: "fix", round: 1, state: "done" },
      { step: "review", round: 2, state: "done" }, { step: "fix", round: 2, state: "done" }, { step: "final_review", round: 3, state: "assigned" },
    ] };
    const f = feature("F1", [node("A", "active", [], { stepLine: sl }), node("B", "active", [], { stepLine: { ...sl, active: { step: "review", round: 2, roundUnknown: true } } })]);
    const m = subdagFocus(f, null, NOW);
    const a = m.active.find((c) => c.nodeKey === "A")!;
    expect(a.step).toEqual({ label: label("review"), round: 3 });
    expect(a.rounds).toEqual({ review: 3, fix: 2 });
    expect(m.active.find((c) => c.nodeKey === "B")!.step).toEqual({ label: label("review"), round: null });
  });

  test("没 stepLine：step、rounds 都为 null；publishing 写交付中", () => {
    const f = feature("F1", [node("A", "active", [], { stepLine: null }), node("B", "active")]);
    const m = subdagFocus(f, local({ working: [workRow("B", { step: "publishing" })] }), NOW);
    const a = m.active.find((c) => c.nodeKey === "A")!;
    expect([a.step, a.rounds]).toEqual([null, null]);
    expect(m.active.find((c) => c.nodeKey === "B")!.step).toEqual({ label: "交付中", round: null });
  });

  test("lastEvent 转成 { at, kind, text }，缺了是 null", () => {
    const f = feature("F1", [node("A", "active", [], { lastEvent: { at: 7, actor: "x", kind: "review", text: "审过" } }), node("B", "active")]);
    const m = subdagFocus(f, null, NOW);
    expect(m.active.find((c) => c.nodeKey === "A")!.lastEvent).toEqual({ at: 7, kind: "review", text: "审过" });
    expect(m.active.find((c) => c.nodeKey === "B")!.lastEvent).toBeNull();
  });
});

describe("分组 [验收线 3]", () => {
  test("两个互相依赖的 idle 节点不死循环，都进 far", () => {
    const m = subdagFocus(feature("F1", [node("X", "idle", ["Y"]), node("Y", "idle", ["X"])]), null, NOW);
    expect(keys(m.next.far).sort()).toEqual(["X", "Y"]);
    expect(m.next.far.every((r) => r.hops >= 2)).toBe(true);
  });

  test("ready 的 reason 照搬本机 todo 行；没有行时为 null；依赖 ready 节点的进 far", () => {
    const f = feature("F1", [node("R", "idle"), node("S", "idle"), node("T", "idle", ["R"])]);
    const m = subdagFocus(f, local({ todo: { ready: [workRow("R", { reason: "缺规格" })], blocked: [] } }), NOW);
    expect(m.next.ready.map((r) => [r.nodeKey, r.reason])).toEqual([["R", "缺规格"], ["S", null]]);
    expect(m.next.far.map((r) => [r.nodeKey, r.hops, r.waitsOn])).toEqual([["T", 2, ["R"]]]);
    expect(subdagFocus(f, null, NOW).next.ready.every((r) => r.reason === null)).toBe(true);
  });
});

describe("依赖三项 [验收线 4]", () => {
  test("链 A→B→C 中 C 已完成：A 的 unlock 为 1；up / down 一跳", () => {
    const f = feature("F1", [node("A", "active", ["Z"]), node("B", "idle", ["A"]), node("C", "done", ["B"]), node("Z", "done")]);
    const a = subdagFocus(f, null, NOW).active[0]!;
    expect(a.unlock).toBe(1);
    expect(a.up).toEqual([{ nodeKey: "Z", done: true }]);
    expect(a.down).toEqual(["B"]);
  });

  test("菱形依赖不重复计", () => {
    const f = feature("F1", [node("A", "active"), node("B", "idle", ["A"]), node("C", "idle", ["A"]), node("D", "idle", ["B", "C"])]);
    expect(subdagFocus(f, null, NOW).active[0]!.unlock).toBe(3);
  });
});

describe("字段来源 [验收线 5]", () => {
  const f = feature("F1", [node("A", "active", [], { since: 4000 })]);

  test("本机行优先于节点回退", () => {
    const c = subdagFocus(f, local({ working: [workRow("A", { who: "w", machine: "m", since: 9000, normalMinutes: 12, reason: "r" })] }), NOW).active[0]!;
    expect([c.who, c.machine, c.since, c.normalMinutes, c.overMinutes, c.reason]).toEqual(["w", "m", 9000, 12, 0, "r"]);
  });

  test("work 为 null：who / since 退回节点，normalMinutes / overMinutes 为 null", () => {
    const c = subdagFocus(f, null, NOW).active[0]!;
    expect([c.who, c.since, c.normalMinutes, c.overMinutes, c.machine, c.family]).toEqual(["exec-A", 4000, null, null, null, null]);
    expect(c.taskId).toBe("T-A");
  });

  test("团队行没有 since / normalMinutes：都为 null，不编", () => {
    const c = subdagFocus(f, { kind: "team", board: teamWorkBoard({ working: [teamRow("A", { who: "m-3", machine: "Bo" })] }) }, NOW).active[0]!;
    expect([c.who, c.machine, c.since, c.normalMinutes, c.overMinutes, c.family]).toEqual(["m-3", "Bo", null, null, null, null]);
  });
});

describe("已完成 [验收线 6]", () => {
  test("有 doneAt 的按时间降序，没有的排后面保持原顺序", () => {
    const f = feature("F1", [node("P", "done"), node("Q", "done", [], { doneAt: 10 }), node("R", "done"), node("S", "done", [], { doneAt: 20 })]);
    const m = subdagFocus(f, null, NOW);
    expect(m.done.map((d) => [d.nodeKey, d.at])).toEqual([["S", 20], ["Q", 10], ["P", null], ["R", null]]);
    expect(m.head.done24h).toBe(0);
  });

  test("所有已完成都没有 doneAt：done24h 为 null；round 缺为 0", () => {
    const m = subdagFocus(feature("F1", [node("P", "done"), node("Q", "done", [], { status: "cancelled" })]), null, NOW);
    expect(m.head.done24h).toBeNull();
    expect(m.done.map((d) => [d.round, d.cancelled])).toEqual([[0, false], [0, true]]);
  });
});

describe("autoOpenDone [验收线 7]", () => {
  test("全完成为 true；有 1 张进行中为 false", () => {
    expect(subdagFocus(feature("F1", [node("A", "done"), node("B", "done", ["A"])]), null, NOW).autoOpenDone).toBe(true);
    expect(subdagFocus(feature("F1", [node("A", "done"), node("B", "active", ["A"])]), null, NOW).autoOpenDone).toBe(false);
  });
});

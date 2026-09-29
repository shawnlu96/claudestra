/** 协作视图的步骤线（T51，web/features/collab/collab-step-line-model.ts）：顺序与空位、推断、当前这一步、三种等待、外部实例与真校验 / 凭声明 */
import { describe, expect, test } from "bun:test";
import { SLOT_KEYS, stepLineView } from "../web/features/collab/collab-step-line-model";

const row = (o: Record<string, unknown>) => ({ taskId: "T1", round: 0, state: "assigned", headFrom: null, headTo: null, verdict: null, verified: {}, claims: {}, ...o });
const info = (steps: unknown[], active: unknown = null, awaitingPeerOwner = false) => ({ steps, active, awaitingPeerOwner });

describe("stepLineView", () => {
  test("老 bridge 没有 stepLine / 形状不对：null；整条线固定 7 格，没派的是空位", () => {
    expect(stepLineView(undefined, "build")).toBeNull();
    expect(stepLineView({ steps: "x" }, "build")).toBeNull();
    const v = stepLineView(info([row({ step: "write", executor: "agent-x", executorKind: "agent" })]), "build")!;
    expect(v.slots.map((s) => s.key)).toEqual([...SLOT_KEYS]);
    expect(v.slots.map((s) => s.label)).toEqual(["复述", "写", "审查", "修", "看界面", "合并部署", "核对"]);
    expect(v.slots.filter((s) => s.filled).map((s) => s.key)).toEqual(["write"]);
    expect(v.slots.find((s) => s.key === "merge")).toMatchObject({ filled: false, executor: null, state: null });
  });

  test("全是推出来的（老卡）：整条线标推断；混着库里的行就不算", () => {
    const d = row({ step: "write", executor: "agent-x", executorKind: "agent", derived: true });
    expect(stepLineView(info([d]), "build")!.derivedOnly).toBe(true);
    expect(stepLineView(info([d, row({ step: "review", executor: "agent-r", executorKind: "agent" })]), "build")!.derivedOnly).toBe(false);
  });

  test("外部执行者带实例名；本机核过的和对方自报的分开；本机 agent 的模型从会话列表查（不算声明）", () => {
    const v = stepLineView(info([
      row({ step: "write", executor: "agent-a@HedeMacBook", executorKind: "peer", state: "delivered", headFrom: "1111111111", headTo: "2222222222" }),
      row({ step: "review", executor: "agent-outer-codex@Sekai", executorKind: "peer", state: "done", verdict: "changes",
        verified: { author: "agent-a@HedeMacBook", reviewerNotAuthor: true }, claims: { model: "gpt-6-astra" } }),
      row({ step: "fix", executor: "agent-x", executorKind: "agent" }),
      row({ step: "ui_check", executor: "local:owner", executorKind: "human" }),
    ]), "fix", (n) => (n === "agent-x" ? "claude-opus-5-5" : null))!;
    const [, write, review, fix, ui] = v.slots;
    expect(write).toMatchObject({ executor: "a", instance: "HedeMacBook", kind: "peer", state: "delivered", heads: "11111111..22222222", model: null });
    expect(review).toMatchObject({ executor: "outer-codex", instance: "Sekai", verdict: "changes", verified: "本机核过：审的人不是写的人", model: { name: "gpt-6-astra", claimed: true } });
    expect(fix).toMatchObject({ executor: "x", instance: null, model: { name: "claude-opus-5-5", claimed: false } });
    expect(ui).toMatchObject({ executor: "local:owner", kind: "human", instance: null });
    const same = stepLineView(info([row({ step: "review", executor: "r@A", executorKind: "peer", verified: { reviewerNotAuthor: null, why: "同一实例" } })]), "review")!;
    expect(same.slots[2].verified).toBe("同一实例，凭对方声明");
  });

  test("审查格：初审、终审取轮次大的，同一轮终审优先；当前这一步按 bridge 给的 active 认（轮次也要对上）", () => {
    const steps = [
      row({ step: "review", executor: "agent-r1", executorKind: "agent", round: 1 }),
      row({ step: "final_review", executor: "c@C", executorKind: "peer", round: 1 }),
      row({ step: "review", executor: "agent-r0", executorKind: "agent", round: 0 }),
    ];
    const v = stepLineView(info(steps, { step: "final_review", round: 1 }), "review")!;
    expect(v.slots[2]).toMatchObject({ executor: "c", final: true, current: true, round: 1 });
    expect(v.current?.key).toBe("review");
    const newer = stepLineView(info([...steps, row({ step: "review", executor: "agent-r2", executorKind: "agent", round: 2 })], { step: "review", round: 1 }), "review")!;
    expect(newer.slots[2]).toMatchObject({ executor: "r2", final: false, current: false }); // active 指的是上一轮：这一格不算当前
    expect(newer.current).toBeNull();
  });

  test("三种等待：blocked → 卡住；等对方 owner（bridge 判）；review → 等审查；其余没有", () => {
    const one = [row({ step: "write", executor: "agent-x", executorKind: "agent" })];
    expect(stepLineView(info(one), "blocked")!.wait).toBe("blocked");
    expect(stepLineView(info(one, null, true), "spec")!.wait).toBe("owner");
    expect(stepLineView(info(one), "review")!.wait).toBe("review");
    expect(stepLineView(info(one), "build")!.wait).toBeNull();
    expect(stepLineView(info(one, null, true), "blocked")!.wait).toBe("blocked"); // 卡住优先
  });

  test("head 区间：两头一样只写一个；没有 headFrom 只写 headTo；未知状态 / 结论丢掉", () => {
    const v = stepLineView(info([
      row({ step: "write", executor: "agent-x", executorKind: "agent", headFrom: "abcdef1234", headTo: "abcdef1234", state: "weird", verdict: "maybe" }),
      row({ step: "fix", executor: "agent-x", executorKind: "agent", headTo: "9999999999" }),
    ]), "fix")!;
    expect(v.slots[1]).toMatchObject({ heads: "abcdef12", state: null, verdict: null });
    expect(v.slots[3].heads).toBe("99999999");
  });
});

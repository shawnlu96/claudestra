/** 协作详情的「步骤」段（web/features/collab/collab-steps.ts）：只画派过步骤的卡，本机核过的和对方自报的分开写 */
import { describe, expect, test } from "bun:test";
import { stepRows } from "../web/features/collab/collab-steps";

const row = (o: Record<string, unknown>) => ({ taskId: "T1", round: 0, state: "assigned", headFrom: null, headTo: null, verdict: null, verified: {}, claims: {}, ...o });

describe("stepRows", () => {
  test("老卡（全是推出来的）不出这一段；形状不对的丢掉", () => {
    expect(stepRows([row({ step: "write", executor: "agent-x", executorKind: "agent", derived: true })])).toEqual([]);
    expect(stepRows(null)).toEqual([]);
    expect(stepRows([row({ step: "nope", executor: "x" }), row({ step: "write", executor: "agent-x", executorKind: "agent" })]).map((r) => r.step)).toEqual(["write"]);
  });

  test("按步骤顺序排；head 区间取短 sha；本机核过 / 作者未知 / 同一实例凭声明；自报模型单列", () => {
    const rows = stepRows([
      row({ step: "review", executor: "agent-outer-codex@Sekai", executorKind: "peer", state: "done", verdict: "changes",
        verified: { author: "agent-a@A", reviewerNotAuthor: true }, claims: { model: "gpt-5-codex" } }),
      row({ step: "write", executor: "agent-a@A", executorKind: "peer", state: "delivered", headFrom: "1111111111", headTo: "2222222222" }),
      row({ step: "final_review", executor: "agent-z", executorKind: "agent", verified: { author: null, reviewerNotAuthor: null, why: "作者未知" } }),
    ]);
    expect(rows.map((r) => [r.label, r.executor, r.peer, r.heads, r.verdict, r.checked, r.claimedModel])).toEqual([
      ["写", "a@A", true, "11111111..22222222", null, null, null],
      ["初审", "outer-codex@Sekai", true, null, "changes", "本机核过：审的人不是写的人", "gpt-5-codex"],
      ["终审", "z", false, null, null, "作者未知", null],
    ]);
  });
});

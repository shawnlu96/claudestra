/** UXASK1：GET /asks 补任务标题——只给读得了台账的凭据，同一个卡号只查一次，查失败不连累列表 */
import { describe, expect, test } from "bun:test";
import { TASK_TITLE_MAX, withTaskTitles } from "../src/lib/ask-task-title";

const rows = () => [
  { id: "a", taskId: "i28-A7" },
  { id: "b", taskId: null },
  { id: "c", taskId: "i28-A7" },
  { id: "d", taskId: "gone" },
];

describe("withTaskTitles", () => {
  test("allowed=false（guest 读不了台账）：一个字段都不加，也不去查", () => {
    let calls = 0;
    const out = withTaskTitles(rows(), () => (calls++, "侧栏会话行芯片解释"), false);
    expect(out).toEqual(rows());
    expect(out.some((r) => "taskTitle" in r)).toBe(false);
    expect(calls).toBe(0);
  });

  test("allowed=true：查到才加，同一个 taskId 只查一次，没卡号的不查", () => {
    const seen: string[] = [];
    const out = withTaskTitles(rows(), (id) => (seen.push(id), id === "i28-A7" ? "侧栏会话行芯片解释" : null), true);
    expect(seen).toEqual(["i28-A7", "gone"]);
    expect(out.map((r) => r.taskTitle)).toEqual(["侧栏会话行芯片解释", undefined, "侧栏会话行芯片解释", undefined]);
    expect("taskTitle" in out[1]!).toBe(false);
    expect("taskTitle" in out[3]!).toBe(false);
  });

  test("标题截到 80 字（按字符，不切坏汉字）", () => {
    const long = "长".repeat(120);
    const [r] = withTaskTitles([{ taskId: "t" }], () => long, true);
    expect(TASK_TITLE_MAX).toBe(80);
    expect(r!.taskTitle).toBe("长".repeat(80));
  });

  test("lookup 抛错：这一行不加字段，别的行照常、列表照常返回", () => {
    const out = withTaskTitles([{ taskId: "bad" }, { taskId: "ok" }], (id) => {
      if (id === "bad") throw new Error("ledger locked");
      return "好的";
    }, true);
    expect(out).toHaveLength(2);
    expect("taskTitle" in out[0]!).toBe(false);
    expect(out[1]!.taskTitle).toBe("好的");
  });
});

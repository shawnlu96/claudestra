import { expect, test } from "bun:test";
import { classifyPmPush, type DigestInput } from "../src/lib/pm-digest.js";

const lend = (body: string): DigestInput =>
  ({ fromKind: "local", sender: "lend", intent: "request", triggerKind: "agent_tool", oneShot: true, body });

// [验收线 1]
test("lend halted / outcome-unknown notice goes out now", () => {
  const body = "出借单 lend:agents-X1:s1:r0:a0 报 worker 已停：超过 6 小时没交结论，结果不明，交你核对：ledger lend-reoffer lend:agents-X1:s1:r0:a0 或 lend-cancel lend:agents-X1:s1:r0:a0";
  expect(classifyPmPush(lend(body))).toMatchObject({ send: "now", reason: "正文像要紧事 / 要回答" });
});

test("each halt / recheck word alone makes an agent oneShot message urgent", () => {
  for (const w of ["已停", "停了", "结果不明", "交你", "请核对", "撤单", "重派", "超时"]) {
    expect(classifyPmPush(lend(`出借单 o1 ${w}`)).send).toBe("now");
  }
});

// [验收线 2]
test("lend pure progress sync stays mergeable", () => {
  expect(classifyPmPush(lend("出借:HedeMacBook-Pro 领了开工单(agent-lend-xxx)"))).toMatchObject({ send: "digest", kind: "sync", source: "lend" });
});

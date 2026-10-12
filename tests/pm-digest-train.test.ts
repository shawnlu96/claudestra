import { expect, test } from "bun:test";
import { classifyPmPush, type DigestInput } from "../src/lib/pm-digest.js";

/** 调度器的推送：scheduler-merge-train-tick.ts 经 notifyProjectPm 以 fromName scheduler 发出 */
const sched = (body: string): DigestInput => ({ fromKind: "local", sender: "scheduler", intent: "request", triggerKind: "agent_tool", oneShot: false, body });

test("merge-train bisect progress and car CI red are mergeable (the scheduler keeps bisecting on its own)", () => {
  const bisect = classifyPmPush(sched("[合并列车] 第 136 辆车 3s-4dk1i：第 2 层二分：[agents-A1、agents-B2] / [PR1192]"));
  expect(bisect).toMatchObject({ send: "digest", kind: "train", source: "scheduler" });
  const red = classifyPmPush(sched("[合并列车] 第 136 辆车 3s-4dk1i：车厢 3s-4dk1ia（PR1169、agents-C3）CI 红：test shard 1 of 4；日志没取到：run 1 is still in progress"));
  expect(red).toMatchObject({ send: "digest", kind: "train", reason: "合并列车二分 / 车厢 CI 红" });
});

test("other merge-train notices, multi-line bodies and look-alikes still wake PM now", () => {
  for (const body of [
    "[合并列车] 第 136 辆车 3s-4dk1i：作废：base 变了",
    "[合并列车] 第 136 辆车 3s-4dk1i：组车 3 张：agents-A1、agents-B2、PR1192，起点 main 2142f76b1bdc",
    "[合并列车] 第 136 辆车 3s-4dk1i：第 2 层二分：[agents-A1] / [agents-B2]\n另：合并预检失败，要 PM 处理",
    "第 2 层二分：[agents-A1] / [agents-B2]",
  ]) expect(classifyPmPush(sched(body))).toEqual({ send: "now", reason: "调度器其他通知" });
  // 不是调度器发的，照 agent 规则走（等回复 → 立即送）
  const agent: DigestInput = { ...sched("[合并列车] 第 1 辆车 x：第 1 层二分：[a] / [b]"), sender: "agent-worker" };
  expect(classifyPmPush(agent)).toMatchObject({ send: "now" });
});

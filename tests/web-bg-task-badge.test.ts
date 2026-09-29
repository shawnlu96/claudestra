import { describe, expect, test } from "bun:test";
import { bgTaskBadge } from "@/features/chat/bg-task-badge";

const run = { status: "running" as const };
const done = { status: "done" as const };

describe("bgTaskBadge（顶栏后台任务按钮的徽标）", () => {
  test("有在跑的：数字 = 在跑数，不弱化", () => {
    expect(bgTaskBadge([run, run, run])).toEqual({ show: true, running: 3, done: 0, count: 3, muted: false });
  });
  test("在跑 + 已完成混合：数字只数在跑的", () => {
    expect(bgTaskBadge([done, run, done, run])).toEqual({ show: true, running: 2, done: 2, count: 2, muted: false });
  });
  test("只有已完成：按钮显示但弱化，不画数字", () => {
    expect(bgTaskBadge([done, done])).toEqual({ show: true, running: 0, done: 2, count: 0, muted: true });
  });
  test("一个都没有：按钮不显示", () => {
    expect(bgTaskBadge([])).toEqual({ show: false, running: 0, done: 0, count: 0, muted: true });
  });
});

import { describe, expect, test } from "bun:test";
import { BaselineKeys } from "../src/lib/baseline-keys";

describe("BaselineKeys (bg-activity-watcher 重启防重放的作用域)", () => {
  test("同一 agent-session 只有第一次是 baseline", () => {
    const b = new BaselineKeys();
    expect(b.first("agent-a", "s1")).toBe(true);
    expect(b.first("agent-a", "s1")).toBe(false);
    expect(b.first("agent-a", "s1")).toBe(false);
  });

  test("晚进入监视的 agent 不受首轮影响——自己也走一次 baseline(109 张幽灵卡的根因)", () => {
    const b = new BaselineKeys();
    expect(b.first("agent-a", "s1")).toBe(true); // 首轮只有 a
    expect(b.first("agent-a", "s1")).toBe(false);
    // 22 分钟后 b 的 sessionId 写回 registry,进入列表:进程级单标志会返回 false → 全量重播
    expect(b.first("agent-b", "s9")).toBe(true);
  });

  test("同一 agent 换 session(restart / resume)= 新目录,重新 baseline", () => {
    const b = new BaselineKeys();
    expect(b.first("agent-a", "s1")).toBe(true);
    expect(b.first("agent-a", "s2")).toBe(true);
    expect(b.first("agent-a", "s2")).toBe(false);
    expect(b.size).toBe(2);
  });

  test("prune 按 agent 名过滤:退休 agent 的 key 删,在册 agent 的旧 session key 留", () => {
    const b = new BaselineKeys();
    b.first("agent-a", "s1");
    b.first("agent-a", "s2");
    b.first("agent-gone", "s7");
    b.first("agent:with:colons", "s8"); // agent 名含冒号也要按最后一个冒号切
    expect(b.prune(["agent-a", "agent:with:colons"])).toBe(1);
    expect(b.size).toBe(3);
    expect(b.first("agent-a", "s1")).toBe(false); // 旧 session key 仍在
    expect(b.first("agent-gone", "s7")).toBe(true); // 退休后再回来 = 重新 baseline
  });
});

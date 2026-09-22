/**
 * 把「跑在 Claudestra 之外的 Claude Code」接管进 tmux（v2.24+）。
 *
 * owner 2026-09-22：「你应该自动的有这么一个办法去把进程重启到 tmux 里啊。」
 * 进程搬不动（控制终端出生即定），能做的是「让它干净退出 + 在我们这边 resume
 * 同一个 sessionId」。这里锁住的是**谁该被接管**——判错的代价是去 kill 一个
 * 用户正在用的进程。
 */
import { describe, test, expect } from "bun:test";
import { classifyRunning, mayTakeOver, paneIdOf, takeoverCandidates, type RunningCc } from "../src/lib/takeover.js";

const ours = new Set(["%994", "%830"]);
const managed = new Set(["sid-managed"]);
const mk = (o: Partial<RunningCc>): RunningCc =>
  ({ pid: 100, sessionId: "sid-x", cwd: "/Users/x/proj", ...o });

describe("paneIdOf", () => {
  test("从 session:window.pane 里取 pane id", () => {
    expect(paneIdOf("master:@994.%994")).toBe("%994");
    expect(paneIdOf("mysess:@1.%7")).toBe("%7");
  });
  test("不在 tmux 里跑就没有这个字段", () => {
    expect(paneIdOf(undefined)).toBeNull();
    expect(paneIdOf("")).toBeNull();
    expect(paneIdOf("master")).toBeNull();
  });
});

describe("classifyRunning", () => {
  test("pane 在我们 socket 上 → 已经在里面，不用动", () => {
    expect(classifyRunning(mk({ tmux: "master:@994.%994" }), ours, managed)).toBe("inside");
  });

  test("registry 已登记 → 已经在里面（比 pane 更硬的证据）", () => {
    expect(classifyRunning(mk({ sessionId: "sid-managed" }), ours, managed)).toBe("inside");
  });

  test("裸 iTerm 窗口（根本没有 tmux 字段）→ 可接管", () => {
    expect(classifyRunning(mk({}), ours, managed)).toBe("ready");
  });

  test("跑在**别人自己的** tmux 里 → 同样可接管（pane 号不在我们 socket 上）", () => {
    expect(classifyRunning(mk({ tmux: "work:@3.%3" }), ours, managed)).toBe("ready");
  });

  test("正在跑回合 → busy，要显式 force 才碰", () => {
    expect(classifyRunning(mk({ status: "busy" }), ours, managed)).toBe("busy");
  });

  test("status=shell（退回 shell 了）不算 busy", () => {
    expect(classifyRunning(mk({ status: "shell" }), ours, managed)).toBe("ready");
  });
});

describe("takeoverCandidates", () => {
  test("已经在里面的不列出来（列了只会让人以为要做什么）", () => {
    const got = takeoverCandidates(
      [mk({ sessionId: "a", tmux: "master:@994.%994" }), mk({ sessionId: "b" })],
      ours, managed,
    );
    expect(got.map((c) => c.sessionId)).toEqual(["b"]);
  });

  test("同一个 session 的多条登记（旧 pid 残留）只算一次", () => {
    const got = takeoverCandidates([mk({ sessionId: "b", pid: 1 }), mk({ sessionId: "b", pid: 2 })], ours, managed);
    expect(got).toHaveLength(1);
  });

  test("字段不全的登记直接跳过（没有 cwd 就 resume 不了）", () => {
    const got = takeoverCandidates(
      [{ pid: 1, sessionId: "c", cwd: "" }, { pid: 0, sessionId: "d", cwd: "/x" }, mk({ sessionId: "e" })],
      ours, managed,
    );
    expect(got.map((c) => c.sessionId)).toEqual(["e"]);
  });
});

describe("mayTakeOver", () => {
  test("busy 默认不许动 —— 会打断人家正在跑的回合", () => {
    const c = { ...mk({ status: "busy" }), verdict: "busy" as const };
    expect(mayTakeOver(c, false).ok).toBe(false);
    expect(mayTakeOver(c, false).reason).toContain("--force");
  });
  test("显式 force 才放行", () => {
    expect(mayTakeOver({ ...mk({ status: "busy" }), verdict: "busy" as const }, true).ok).toBe(true);
  });
  test("ready 一律放行", () => {
    expect(mayTakeOver({ ...mk({}), verdict: "ready" as const }, false).ok).toBe(true);
  });
});

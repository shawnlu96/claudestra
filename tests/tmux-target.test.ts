/**
 * tmux 目标串与失败暴露（2026-09-21 实锤事故）。
 *
 * 现场：master session 里混进一个**窗口名也叫 `master`** 的闲置 zsh（index 19），
 * 于是 `tmux new-window -t master -n agent-xxx` 落到那个窗口上、报
 * `create window failed: index 19 in use` 退出码 1 —— 而 `tmuxRaw` 吞掉退出码，
 * `cmdCreate` 照常往下 send-keys 给一个不存在的窗口，90 秒后报「Claude Code 启动
 * 超时」。错误信息指向的阶段在 new-window **之后**，真正炸的点在它之前。
 *
 * tmux 侧语义已在真 tmux 上实测（见 PR 正文）：
 *   new-window -t master   → create window failed: index N in use   (exit 1)
 *   new-window -t master:  → 挑下一个空闲 index                      (exit 0)
 *   list-windows -t master / master: → 两种写法等价（它只吃 session 目标）
 */
import { describe, test, expect } from "bun:test";
import {
  sessionTarget,
  formatTmuxFailure,
  MASTER_SESSION,
} from "../src/lib/tmux-helper.js";

describe("sessionTarget", () => {
  test("带冒号 = 强制按 session 解析（本次事故的正主）", () => {
    expect(sessionTarget("master")).toBe("master:");
  });

  test("缺省就是 MASTER_SESSION", () => {
    expect(sessionTarget()).toBe(`${MASTER_SESSION}:`);
  });

  test("与窗口目标不是一回事——别把两者写混", () => {
    // windowTarget("agent-x") === "master:agent-x"：落到具体窗口
    // sessionTarget()        === "master:"       ：落到 session，自己挑空闲 index
    expect(sessionTarget()).not.toBe(`${MASTER_SESSION}:agent-x`);
    expect(sessionTarget().endsWith(":")).toBe(true);
  });

  test("拼进 new-window 参数里的形状", () => {
    const args = ["new-window", "-t", sessionTarget(), "-n", "agent-x", "-c", "/tmp"];
    expect(args).toEqual(["new-window", "-t", "master:", "-n", "agent-x", "-c", "/tmp"]);
  });
});

describe("formatTmuxFailure", () => {
  test("把真实报错原样带出来——这正是当初被吞掉的那句", () => {
    const msg = formatTmuxFailure(
      ["new-window", "-t", "master", "-n", "agent-x"],
      1,
      "create window failed: index 19 in use",
    );
    expect(msg).toContain("tmux new-window -t master -n agent-x");
    expect(msg).toContain("exit 1");
    expect(msg).toContain("index 19 in use");
  });

  test("没有 stderr 也要说清是哪条命令、退出码多少", () => {
    const msg = formatTmuxFailure(["kill-window", "-t", "master:9"], 1, "");
    expect(msg).toContain("kill-window -t master:9");
    expect(msg).toContain("exit 1");
  });

  test("超时被杀（code=null）要能认出来，不要显示成 exit 0", () => {
    const msg = formatTmuxFailure(["new-window", "-t", "master:"], null, "");
    expect(msg).toContain("null");
    expect(msg).toContain("超时");
  });
});

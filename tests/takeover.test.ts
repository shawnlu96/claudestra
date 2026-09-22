/**
 * 把「跑在 Claudestra 之外的 Claude Code」接管进 tmux（v2.24+）。
 *
 * owner 2026-09-22：「你应该自动的有这么一个办法去把进程重启到 tmux 里啊。」
 * 进程搬不动（控制终端出生即定），能做的是「让它干净退出 + 在我们这边 resume
 * 同一个 sessionId」。这里锁住的是**谁该被接管**——判错的代价是去 kill 一个
 * 用户正在用的进程。
 */
import { describe, test, expect } from "bun:test";
import { classifyRunning, mayTakeOver, paneIdOf, preflightProblems, recoverCommand, resumeOutcome, takeoverCandidates, type RunningCc } from "../src/lib/takeover.js";
import { bypassConsentGiven, claudeUserSettingsPath } from "../src/lib/bypass-consent.js";
import { parseCcSessionEntry } from "../src/lib/cc-sessions.js";

const ours = new Set(["%994", "%830"]);
const managed = new Set(["sid-managed"]);
const mk = (o: Partial<RunningCc>): RunningCc =>
  ({ pid: 100, sessionId: "sid-x", cwd: "/Users/x/proj", kind: "interactive", ...o });

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

describe("从登记文件到判决（端到端：解析不能丢 status / kind）", () => {
  // 曾经的缺口：parseCcSessionEntry 丢了 status，磁盘上 busy 的会话被判成 ready
  const raw = (o: Record<string, unknown>) =>
    JSON.stringify({ pid: 72201, sessionId: "sid-real", cwd: "/Users/x/proj", kind: "interactive", ...o });

  test("磁盘上 status=busy → busy，不带 --force 不动", () => {
    const e = parseCcSessionEntry(raw({ status: "busy" }))!;
    const [c] = takeoverCandidates([e], ours, managed);
    expect(c.verdict).toBe("busy");
    expect(mayTakeOver(c, false).ok).toBe(false);
  });

  test("非 interactive（bg job / sdk）或缺 kind → 不是候选", () => {
    expect(takeoverCandidates([parseCcSessionEntry(raw({ kind: "bg" }))!], ours, managed)).toHaveLength(0);
    expect(takeoverCandidates([parseCcSessionEntry(raw({ kind: undefined }))!], ours, managed)).toHaveLength(0);
  });
});

describe("resumeOutcome —— 原进程已被关掉，resume 的成败必须如实", () => {
  test("cmdResume 成功那一行", () => {
    expect(resumeOutcome(['{"ok":true,"agent":"agent-proj","ready":true}'])).toEqual({ ok: true, agent: "agent-proj" });
  });
  test("cmdResume 失败 → ok:false 带原因", () => {
    const r = resumeOutcome(['{"ok":false,"error":"创建 Discord 频道失败: ECONNREFUSED"}']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
  test("没有任何 JSON 结论（抛异常 / 中途退出）→ 失败，绝不当成功", () => {
    expect(resumeOutcome([]).ok).toBe(false);
    expect(resumeOutcome(["some log line"]).ok).toBe(false);
  });
  test("以最后一条结论为准", () => {
    expect(resumeOutcome(['{"ok":true}', '{"ok":false,"error":"x"}']).ok).toBe(false);
  });
});

describe("preflightProblems —— SIGTERM 前的全局前置条件", () => {
  const good = { bypassAccepted: true, masterSession: true, bridgeReachable: true };
  test("全部满足 → 可以动手", () => {
    expect(preflightProblems(good)).toEqual([]);
  });
  test("任何一项不满足都列出来（调用方据此一个进程都不动）", () => {
    expect(preflightProblems({ ...good, bypassAccepted: false })[0]).toContain("bypass");
    expect(preflightProblems({ ...good, masterSession: false })[0]).toContain("master");
    expect(preflightProblems({ ...good, bridgeReachable: false })[0]).toContain("bridge");
    expect(preflightProblems({ bypassAccepted: false, masterSession: false, bridgeReachable: false })).toHaveLength(3);
  });
});

describe("bypass 同意记录", () => {
  test("只认用户级 settings 里显式的 true", () => {
    expect(bypassConsentGiven({ skipDangerousModePermissionPrompt: true })).toBe(true);
    expect(bypassConsentGiven({ skipDangerousModePermissionPrompt: "true" })).toBe(false);
    expect(bypassConsentGiven({})).toBe(false);
    expect(bypassConsentGiven(null)).toBe(false);
  });
  test("settings 路径尊重 CLAUDE_CONFIG_DIR", () => {
    expect(claudeUserSettingsPath({ HOME: "/h" })).toBe("/h/.claude/settings.json");
    expect(claudeUserSettingsPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/settings.json");
  });
});

describe("recoverCommand", () => {
  test("带空格 / 单引号的目录也能原样粘贴", () => {
    expect(recoverCommand("/Users/x/my proj", "sid")).toBe("cd '/Users/x/my proj' && claude --resume sid");
    expect(recoverCommand("/Users/x/it's", "sid")).toBe(`cd '/Users/x/it'\\''s' && claude --resume sid`);
  });
});

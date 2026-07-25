/**
 * Modal 解析单测：parseModalOptions + detectArrowNavModal
 */

import { describe, test, expect } from "bun:test";
import {
  parseModalOptions,
  detectArrowNavModal,
  isAutoConfirmableModal,
  isClaudeReady,
  paneLooksIdle,
  isAtShell,
  detectSessionIdlePrompt,
  detectPermissionMode,
  probeTuiContract,
  btabStepsTo,
  PERMISSION_MODE_CYCLE,
} from "../src/lib/tmux-helper.js";

describe("parseModalOptions", () => {
  test("识别带 ❯ 选中标记的数字菜单", () => {
    const pane = `
some header text
Select model

❯ 1. Opus 4.7 (1M context)
  2. Sonnet 4.6
  3. Haiku 4.5
`;
    const opts = parseModalOptions(pane);
    expect(opts).not.toBeNull();
    expect(opts!.length).toBe(3);
    expect(opts![0].key).toBe("1");
    expect(opts![0].selected).toBe(true);
    expect(opts![0].label).toContain("Opus");
    expect(opts![1].selected).toBe(false);
  });

  test("只有一个选项不算 modal", () => {
    const pane = `❯ 1. Only option`;
    expect(parseModalOptions(pane)).toBeNull();
  });

  test("没有 ❯ 选中标记视为普通文本，不是 modal", () => {
    const pane = `
Steps to reproduce:
1. First do X
2. Then do Y
3. Finally do Z
`;
    expect(parseModalOptions(pane)).toBeNull();
  });

  test("去重同 key（保留第一次出现的）", () => {
    const pane = `
❯ 1. New option
  2. Another
  1. Old option
`;
    const opts = parseModalOptions(pane);
    expect(opts).not.toBeNull();
    expect(opts!.filter((o) => o.key === "1").length).toBe(1);
    // 第一次出现的是带 ❯ 的
    expect(opts!.find((o) => o.key === "1")!.selected).toBe(true);
  });

  test("超 25 个选项截断（但还是要求至少一个 ❯）", () => {
    // 只用前 20 条放入最后 30 行视野内，带 ❯
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      if (i === 5) lines.push(`❯ ${i}. selected option`);
      else lines.push(`  ${i}. option ${i}`);
    }
    const pane = lines.join("\n");
    const opts = parseModalOptions(pane);
    expect(opts).not.toBeNull();
    expect(opts!.length).toBeLessThanOrEqual(25);
    expect(opts!.length).toBe(20);
  });
});

describe("detectArrowNavModal", () => {
  test("识别 ←/→ + Enter to confirm 的水平 slider", () => {
    const pane = `
   low   medium   high   xhigh   max
                              ▲
←/→ to change effort · Enter to confirm
`;
    expect(detectArrowNavModal(pane)).toBe("horizontal");
  });

  test("识别 ↑/↓ + Enter to confirm 的垂直 picker", () => {
    const pane = `
option A
option B
option C
↑/↓ to navigate · Enter to select
`;
    expect(detectArrowNavModal(pane)).toBe("vertical");
  });

  test("没有 Enter 提示不算 modal", () => {
    const pane = `
just a slider
←/→ to change
`;
    expect(detectArrowNavModal(pane)).toBeNull();
  });

  test("无 hint 文字返回 null", () => {
    const pane = `
Normal response from Claude.
No modal here.
`;
    expect(detectArrowNavModal(pane)).toBeNull();
  });
});

describe("isAutoConfirmableModal", () => {
  test("dev-channel 启动 modal → 自动按", () => {
    const pane = `
WARNING: Loading development channels

--dangerously-load-development-channels is for local channel development only.

Channels: server:claudestra

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
`;
    expect(isAutoConfirmableModal(pane)).toBe(true);
  });

  test("trust files modal → 自动按（哪怕文案变了，几何识别就够了）", () => {
    const pane = `
Some new wording from upstream we have never seen.

❯ 1. Yes, proceed
  2. No, cancel

Enter to confirm
`;
    expect(isAutoConfirmableModal(pane)).toBe(true);
  });

  test("运行时权限弹窗（edit）→ 不自动按", () => {
    const pane = `
Do you want to make this edit to /etc/passwd?

❯ 1. Yes
  2. No, deny

Enter to confirm
`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });

  test("运行时权限弹窗（run command）→ 不自动按", () => {
    const pane = `
Do you want to run rm -rf /tmp/foo?

❯ 1. Yes
  2. No

Enter to confirm
`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });

  test("session-idle 弹窗默认不自动按", () => {
    const pane = `
This session is 21h 6m old and 913.2k tokens.

❯ 1. Resume from summary
  2. Resuming the full session

Enter to confirm
`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });

  test("session-idle 弹窗 allowSessionIdle=true 时自动按（master 启动）", () => {
    const pane = `
This session is 21h 6m old and 913.2k tokens.

❯ 1. Resume from summary
  2. Resuming the full session

Enter to confirm
`;
    expect(isAutoConfirmableModal(pane, { allowSessionIdle: true })).toBe(true);
  });

  test("没 modal 几何特征 → false", () => {
    const pane = `
Just some Claude output. No modal here.
Question: Do you want to know more?
`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });

  test("有数字列表但无 ❯ → false（不是真 modal）", () => {
    const pane = `
Steps:
  1. First do X
  2. Then do Y
Enter to confirm something? (just text)
`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });
});

describe("isClaudeReady", () => {
  test("典型 idle pane（❯ 单独一行 + bypass permissions banner）→ true", () => {
    const pane = `
some banner content
─────────────────────────── claudestra ──
❯
─────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(isClaudeReady(pane)).toBe(true);
  });

  test("❯ 后面带光标占位符（新版 2.1.129 可能渲染） → 仍 true", () => {
    const pane = `
banner
─── claudestra ──
❯ ▎
──────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(isClaudeReady(pane)).toBe(true);
  });

  test("❯ 后面带 placeholder 文字 → 仍 true", () => {
    const pane = `
banner
─── claudestra ──
❯ Type a message...
──────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(isClaudeReady(pane)).toBe(true);
  });

  test("启动中 pane（无 bypass permissions banner）→ false", () => {
    const pane = `
Claude Code v2.1.129
Loading channels...
`;
    expect(isClaudeReady(pane)).toBe(false);
  });

  test("dev-channels 确认 modal（❯ 1. ... 在 last 5 但 banner 还没出）→ false", () => {
    const pane = `
WARNING: Loading development channels

  ❯ 1. I am using this for local development
    2. Exit

Enter to confirm · Esc to cancel
`;
    // 没有 "bypass permissions" → 不算就绪（即便 ❯ 在 last 5）
    expect(isClaudeReady(pane)).toBe(false);
  });

  test("shell prompt（无 ❯）→ false", () => {
    const pane = `➜  some-dir`;
    expect(isClaudeReady(pane)).toBe(false);
  });

  test("v2.0.14: bypass banner 在 scrollback 但 last 10 没 → false（防 dev-channels modal 假阳性）", () => {
    // 模拟 restart 场景：旧 claude session 留下 banner 残留在 scrollback 顶部，
    // 但 last 10 行是 dev-channels modal（没 banner）。修复前会假阳性返回 true，
    // 导致 polling 提前退出没机会按 Enter dismiss modal。
    const pane = `
old assistant output...
  ⏵⏵ bypass permissions on (shift+tab to cycle)
/exit
Goodbye!
[空行很多行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
(base) ➜ dir $ claude --dangerously-load-development-channels server:claudestra
WARNING: Loading development channels

--dangerously-load-development-channels is for local channel development only.

Channels: server:claudestra

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
`;
    expect(isClaudeReady(pane)).toBe(false);
  });
});

describe("paneLooksIdle", () => {
  test("legacy 严格 idle（行只有 ❯）→ true", () => {
    const pane = `
some output
─── claudestra ──
❯
─────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(paneLooksIdle(pane)).toBe(true);
  });

  test("新版 idle（❯ + 光标占位符 ▎）→ true（宽松匹配）", () => {
    const pane = `
some output
─── ld-binance-operate ──
❯ ▎
─────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(paneLooksIdle(pane)).toBe(true);
  });

  test("新版 idle（❯ + placeholder 文字）→ true", () => {
    const pane = `
─── name ──
❯ Type a message...
───────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(paneLooksIdle(pane)).toBe(true);
  });

  test("Claude 在跑工具（pane 含 esc to interrupt）→ false", () => {
    const pane = `
✶ Sock-hopping... (5s · 1.2k tokens · thought for 1s)
  ⎿  Tip: Use /statusline ...
─── claudestra ──
❯ ▎
─────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt
`;
    expect(paneLooksIdle(pane)).toBe(false);
  });

  test("dev-channels modal（无 bypass banner）→ false", () => {
    const pane = `
WARNING: Loading development channels

  ❯ 1. I am using this for local development
    2. Exit

Enter to confirm · Esc to cancel
`;
    expect(paneLooksIdle(pane)).toBe(false);
  });

  test("shell prompt（无 ❯ 也无 banner）→ false", () => {
    const pane = `➜  some-dir`;
    expect(paneLooksIdle(pane)).toBe(false);
  });

  test("permission 弹窗（❯ 1. Yes 在 last 5 但 esc to interrupt 不出现）→ false", () => {
    // permission modal 通常没 bypass banner（被 modal 覆盖），所以两种 mode 都 false
    const pane = `
Do you want to make this edit to /etc/passwd?

❯ 1. Yes
  2. No, deny

Enter to confirm
`;
    expect(paneLooksIdle(pane)).toBe(false);
  });

  test("v2.0.14: stale bypass banner 在 scrollback 但 last 10 是 dev-channels modal → false", () => {
    // 跟 isClaudeReady 的 stale test 同源 — paneLooksIdle 也会被 scrollback 假阳性
    const pane = `
old stuff...
  ⏵⏵ bypass permissions on (shift+tab to cycle)
/exit
Goodbye!
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
[空行]
(base) ➜ dir $ claude --dangerously-load-development-channels server:claudestra
WARNING: Loading development channels

Channels: server:claudestra

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
`;
    expect(paneLooksIdle(pane)).toBe(false);
  });

  test("v2.0.14: 真 idle pane (banner 在 last 10) 仍判 true", () => {
    // 确保收紧 last 10 不影响正常 idle 检测 — banner 永远在输入框下面 1-2 行
    const pane = `
─── ld-binance-operate ──
❯ Try "write a test"
─────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
    expect(paneLooksIdle(pane)).toBe(true);
  });
});

describe("isAtShell", () => {
  // 核心 bug：starship / pure 主题 shell 提示符就是 ❯，跟 claude 输入框同符号。
  // claude 退出后 pane 停在 shell ❯，必须判成 at-shell（掉线），不能当成 claude
  // 卡死（wedge-watcher 之前对这种每小时误报）。
  test("starship/pure shell 提示符 ❯ 结尾 → true", () => {
    const pane = `
❯ /exit
  ⎿  Catch you later!

~/repos/router ❯`;
    expect(isAtShell(pane)).toBe(true);
  });

  test("裸 ❯ shell 提示符 → true", () => {
    expect(isAtShell(`❯`)).toBe(true);
  });

  test("zsh 默认 % 结尾 → true", () => {
    expect(isAtShell(`shawn@mac repos %`)).toBe(true);
  });

  test("bash $ 结尾 → true", () => {
    expect(isAtShell(`user@host:~/dir$`)).toBe(true);
  });

  test("oh-my-zsh robbyrussell ➜ → true", () => {
    expect(isAtShell(`➜  router git:(main) ✗`)).toBe(true);
  });

  test("claude 在跑（有 bypass banner）→ false，即使行尾是 ❯", () => {
    const pane = `
─── router ──
❯
─────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
    expect(isAtShell(pane)).toBe(false);
  });

  test("claude 跑工具中（esc to interrupt）→ false", () => {
    const pane = `
✶ Working... (5s)
─── router ──
❯ ▎
  ⏵⏵ bypass permissions on · esc to interrupt`;
    expect(isAtShell(pane)).toBe(false);
  });

  test("session-idle 选项菜单（❯ 1.）→ false（claude 在跑的 modal）", () => {
    const pane = `
This session is 5h old.
❯ 1. Resume from summary
  2. Resume full session`;
    expect(isAtShell(pane)).toBe(false);
  });
});

describe("detectSessionIdlePrompt", () => {
  test("真 session-idle 弹窗（底部，无 banner）→ 返回描述", () => {
    const pane = `
some scrollback
This session is 5h 6m old and 485.2k tokens.
Resuming the full session will consume a substantial portion of your usage limits.

❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again

Enter to confirm · Esc to cancel`;
    const desc = detectSessionIdlePrompt(pane);
    expect(desc).not.toBeNull();
    expect(desc).toContain("5h 6m old");
  });

  test("核心 bug：屏幕显示检测器自己的测试源码 + claude 在跑 → null", () => {
    // owner 编辑 modal-parser.test.ts，pane 里显示着这段 fixture（含 ❯ 1. Resume
    // from summary），但底部是 claude 正常运行的 bypass banner。不能误判成真弹窗。
    const pane = `
  test("session-idle", () => {
    const pane = \`
    ❯ 1. Resume from summary
      2. Resume full session\`;
  });
─── claudestra ──
❯ ▎
─────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
    expect(detectSessionIdlePrompt(pane)).toBeNull();
  });

  test("modal 文字 + 底部 esc to interrupt（claude 工作中）→ null", () => {
    const pane = `
✶ Editing... showing diff with ❯ 1. Resume from summary
  2. Resume full session as-is
─── agent ──
❯ ▎
  ⏵⏵ bypass permissions on · esc to interrupt`;
    expect(detectSessionIdlePrompt(pane)).toBeNull();
  });

  test("modal 文字在 scrollback、底部已是纯 shell → null", () => {
    // 现实：claude 退出后 modal 文字被推到上面，最后几行是 shell 输出 + 提示符
    const pane = `
This session is 5h old and 100k tokens.
❯ 1. Resume from summary
  2. Resume full session as-is
  3. Don't ask me again
output line one
output line two
output line three
output line four
shawn@mac ~/repos/router %`;
    expect(detectSessionIdlePrompt(pane)).toBeNull();
  });

  test("无 modal 文字 → null", () => {
    expect(detectSessionIdlePrompt(`just normal output\n❯ ▎`)).toBeNull();
  });
});

describe("多权限模式 banner（v2.0.24 泛化）", () => {
  // 不同 --permission-mode 底部 banner 文案不同；旧代码只认 "bypass permissions"
  // 导致 auto/acceptEdits/plan 模式 agent 永远不就绪。这里锁住三函数都认所有模式。
  const mk = (banner: string) => `
─── agent ──
❯ ▎
─────────────
  ${banner} · ← for agents`;

  const banners = [
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
    "⏵⏵ auto mode on (shift+tab to cycle)",
    "⏵⏵ accept edits on (shift+tab to cycle)",
    "⏸ plan mode on (shift+tab to cycle)",
  ];

  for (const b of banners) {
    test(`isClaudeReady 认: ${b.slice(0, 20)}…`, () => {
      expect(isClaudeReady(mk(b))).toBe(true);
    });
    test(`paneLooksIdle 认: ${b.slice(0, 20)}…`, () => {
      expect(paneLooksIdle(mk(b))).toBe(true);
    });
    test(`isAtShell 对 ${b.slice(0, 20)}… 返回 false（claude 在跑）`, () => {
      expect(isAtShell(mk(b))).toBe(false);
    });
  }

  test("auto 模式跑工具中（esc to interrupt）→ paneLooksIdle false", () => {
    const pane = mk("⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt");
    expect(paneLooksIdle(pane)).toBe(false);
  });
});

describe("detectPermissionMode / btabStepsTo（v2.2.0 临时放行）", () => {
  const mk = (banner: string) => `
─── agent ──
❯ ▎
─────────────
  ${banner} · ← for agents`;

  test("各模式 banner → 正确 mode", () => {
    expect(detectPermissionMode(mk("⏵⏵ auto mode on (shift+tab to cycle)"))).toBe("auto");
    expect(detectPermissionMode(mk("⏵⏵ accept edits on (shift+tab to cycle)"))).toBe("acceptEdits");
    expect(detectPermissionMode(mk("⏸ plan mode on (shift+tab to cycle)"))).toBe("plan");
    expect(detectPermissionMode(mk("⏵⏵ bypass permissions on (shift+tab to cycle)"))).toBe("bypassPermissions");
  });

  test("default 模式（无 banner，只有 ❯）→ default", () => {
    expect(detectPermissionMode(`some output\n❯ ▎`)).toBe("default");
  });

  test("纯 shell / 无 ❯ → null", () => {
    expect(detectPermissionMode(`shawn@mac ~/repos %`)).toBeNull();
  });

  test("cycle 顺序固定 auto→default→acceptEdits→plan→bypassPermissions", () => {
    expect([...PERMISSION_MODE_CYCLE]).toEqual([
      "auto", "default", "acceptEdits", "plan", "bypassPermissions",
    ]);
  });

  test("btabStepsTo: auto→bypass = 4，bypass→auto = 1", () => {
    expect(btabStepsTo("auto", "bypassPermissions")).toBe(4);
    expect(btabStepsTo("bypassPermissions", "auto")).toBe(1);
  });

  test("btabStepsTo: 同模式 = 0", () => {
    expect(btabStepsTo("auto", "auto")).toBe(0);
  });

  test("btabStepsTo: acceptEdits→bypass = 2，plan→bypass = 1", () => {
    expect(btabStepsTo("acceptEdits", "bypassPermissions")).toBe(2);
    expect(btabStepsTo("plan", "bypassPermissions")).toBe(1);
  });

  test("btabStepsTo: 未知模式 → -1", () => {
    expect(btabStepsTo("auto", "nope")).toBe(-1);
    expect(btabStepsTo("nope", "auto")).toBe(-1);
  });
});

describe("probeTuiContract — TUI 文案漂移自检", () => {
  const frame = "─".repeat(60);

  test("空闲态（底部模式 banner）→ 契约完好", () => {
    const pane = [frame, "❯ ", frame, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const r = probeTuiContract(pane);
    expect(r.tuiPresent).toBe(true);
    expect(r.matched).toContain("mode-banner");
    expect(r.suspect).toBe(false);
  });

  test("其它权限模式的 banner 同样算命中", () => {
    for (const banner of [
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
      "  ⏸ plan mode on (shift+tab to cycle)",
    ]) {
      const pane = [frame, "❯ ", frame, banner].join("\n");
      expect(probeTuiContract(pane).suspect).toBe(false);
    }
  });

  test("忙碌态（esc to interrupt）→ 契约完好，即使没有 banner", () => {
    const pane = [frame, "✻ Thinking… (esc to interrupt)", frame].join("\n");
    const r = probeTuiContract(pane);
    expect(r.matched).toContain("busy-indicator");
    expect(r.suspect).toBe(false);
  });

  test("TUI 在场但两个判据都不命中 → 判为可疑（这正是要抓的漂移）", () => {
    const drifted = [frame, "❯ ", frame, "  ⏵⏵ yolo mode engaged (press tab-tab to switch)"].join("\n");
    const r = probeTuiContract(drifted);
    expect(r.tuiPresent).toBe(true);
    expect(r.matched).toEqual([]);
    expect(r.suspect).toBe(true);
  });

  test("裸 shell / 空 pane 不误报 —— 那不是契约问题", () => {
    expect(probeTuiContract("shawn@mac ~ % ls\nshawn@mac ~ % ").suspect).toBe(false);
    expect(probeTuiContract("").suspect).toBe(false);
    expect(probeTuiContract("\n\n\n").suspect).toBe(false);
  });

  test("只看末尾 15 行 —— scrollback 里的旧 banner 不算数", () => {
    const stale = ["  ⏵⏵ bypass permissions on (shift+tab to cycle)"]
      .concat(Array(20).fill("output line"))
      .concat([frame, "❯ ", frame, "  ⏵⏵ yolo mode engaged"])
      .join("\n");
    expect(probeTuiContract(stale).suspect).toBe(true);
  });
});

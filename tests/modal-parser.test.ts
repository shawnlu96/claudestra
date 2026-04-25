/**
 * Modal 解析单测：parseModalOptions + detectArrowNavModal
 */

import { describe, test, expect } from "bun:test";
import {
  parseModalOptions,
  detectArrowNavModal,
  isAutoConfirmableModal,
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

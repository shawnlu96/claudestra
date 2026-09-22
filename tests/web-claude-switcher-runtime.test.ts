/**
 * web-1：顶栏模型/effort 切换器按 runtime 分流。只有 Claude Code（runtime 缺失 = 老
 * agent = CC）挂 CC 面板；Pi 挂 PiModelSwitcher；Codex 等其它运行时不渲染——以前
 * 「第三种 runtime 继续走 CC 面板」，Codex 会话拿到 Claude 的模型下拉，点了恒报
 * 「回合进行中」。
 */
import { describe, expect, test } from "bun:test";
import { switcherKindFor } from "@/features/chat/claude-options";

describe("switcherKindFor（顶栏挂哪种切换器）", () => {
  test("Claude Code：显式 claude-code 与缺失 runtime（历史 agent / 老 bridge）都走 CC 面板", () => {
    expect(switcherKindFor("claude-code")).toBe("claude");
    expect(switcherKindFor(undefined)).toBe("claude");
    expect(switcherKindFor(null)).toBe("claude");
    expect(switcherKindFor("")).toBe("claude");
  });

  test("Pi 走自己的切换器", () => {
    expect(switcherKindFor("pi")).toBe("pi");
  });

  test("Codex 与其它运行时不渲染（不再落进 CC 面板）", () => {
    expect(switcherKindFor("codex")).toBeNull();
    expect(switcherKindFor("some-future-runtime")).toBeNull();
  });
});

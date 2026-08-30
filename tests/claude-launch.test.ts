/**
 * claude-launch 权限模式（--permission-mode）测试
 *
 * 重点锁住：
 *   - bypassPermissions 走 --dangerously-skip-permissions（不是 --permission-mode）
 *   - 其余模式走 --permission-mode <mode>
 *   - 未指定 → 回退 bypassPermissions（向后兼容老 agent）
 *   - 模式校验
 */

import { describe, test, expect } from "bun:test";
import {
  buildClaudeCommand,
  isKnownPermissionMode,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
} from "../src/lib/claude-launch.ts";

const base = { channelId: "123", bridgeUrl: "ws://localhost:3847" };

describe("isKnownPermissionMode", () => {
  test("已知模式全过", () => {
    for (const m of PERMISSION_MODES) expect(isKnownPermissionMode(m)).toBe(true);
  });
  test("未知模式 false", () => {
    expect(isKnownPermissionMode("yolo")).toBe(false);
    expect(isKnownPermissionMode("")).toBe(false);
    expect(isKnownPermissionMode("Auto")).toBe(false); // 大小写敏感
  });
  test("默认模式是 bypassPermissions（向后兼容）", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("bypassPermissions");
  });
});

describe("buildClaudeCommand permission mode", () => {
  test("auto → 归一到 bypassPermissions（v2.4.13+ 彻底 deprecated）", () => {
    const cmd = buildClaudeCommand({ ...base, permissionMode: "auto" });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--permission-mode auto");
    expect(cmd).not.toContain("--permission-mode bypassPermissions");
  });

  test("bypassPermissions → --dangerously-skip-permissions，不带 --permission-mode", () => {
    const cmd = buildClaudeCommand({ ...base, permissionMode: "bypassPermissions" });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--permission-mode");
  });

  test("未指定 → 回退 bypass（= 老行为）", () => {
    const cmd = buildClaudeCommand({ ...base });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--permission-mode");
  });

  test("acceptEdits / plan / dontAsk / default 都走 --permission-mode", () => {
    for (const m of ["acceptEdits", "plan", "dontAsk", "default"]) {
      const cmd = buildClaudeCommand({ ...base, permissionMode: m });
      expect(cmd).toContain(`--permission-mode ${m}`);
      expect(cmd).not.toContain("--dangerously-skip-permissions");
    }
  });

  test("空串 / 全空白 → 回退 bypass", () => {
    expect(buildClaudeCommand({ ...base, permissionMode: "" })).toContain("--dangerously-skip-permissions");
    expect(buildClaudeCommand({ ...base, permissionMode: "   " })).toContain("--dangerously-skip-permissions");
  });

  test("dev-channels flag 永远在（跟权限模式正交）", () => {
    const cmd = buildClaudeCommand({ ...base, permissionMode: "auto" });
    expect(cmd).toContain("--dangerously-load-development-channels");
  });
});

// ── v2.21.1+ ultracode 档位(peer owner 请求 2026-08-30)──
import { isKnownRuntimeEffort, isKnownEffort as _ike, buildClaudeCommand as _bcc } from "../src/lib/claude-launch.js";

describe("ultracode effort", () => {
  test("runtime 档位接受 ultracode,启动档位不接受", () => {
    expect(isKnownRuntimeEffort("ultracode")).toBe(true);
    expect(isKnownRuntimeEffort("xhigh")).toBe(true);
    expect(isKnownRuntimeEffort("bogus")).toBe(false);
    expect(_ike("ultracode")).toBe(false);
  });

  test("启动命令里 ultracode 防御性降为 xhigh(session-only 档不进启动 flag)", () => {
    const cmd = _bcc({ channelId: "c1", sessionId: "s1", effort: "ultracode" });
    expect(cmd).toContain("--effort xhigh");
    expect(cmd).not.toContain("ultracode");
  });
});

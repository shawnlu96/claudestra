/**
 * permission-watcher dedup key 测试。
 *
 * v2.0.4 之前的 bug：watcher 用 pane 原文 hash 做去重，session-idle modal
 * 里 "21h 6m old and 913.2k tokens" 时间字段每分钟变 → fingerprint 变 →
 * 每分钟重复发"session 闲置"通知。v2.0.5 改成 (modalKind, normalizedDesc)。
 */

import { describe, test, expect } from "bun:test";
import { computeModalKey } from "../src/bridge/permission-watcher.ts";

describe("computeModalKey", () => {
  test("无 modal 时返回 null", () => {
    expect(computeModalKey(null, null)).toBeNull();
  });

  test("session-idle 单一 key（不带时间）", () => {
    const k1 = computeModalKey("21h 6m old and 913.2k tokens", null);
    const k2 = computeModalKey("21h 7m old and 913.5k tokens", null);
    const k3 = computeModalKey("Session 闲置提示", null);
    expect(k1).toBe("session-idle");
    expect(k2).toBe("session-idle");
    expect(k3).toBe("session-idle");
    // 全部相等 → watcher 不会重复通知
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
  });

  test("permission 弹窗 key 带 desc，不同请求不同 key", () => {
    const k1 = computeModalKey(null, "Edit 文件: /tmp/foo");
    const k2 = computeModalKey(null, "Edit 文件: /tmp/bar");
    const k3 = computeModalKey(null, "执行命令: rm -rf /tmp/x");
    expect(k1).toBe("permission|Edit 文件: /tmp/foo");
    expect(k2).toBe("permission|Edit 文件: /tmp/bar");
    expect(k3).toBe("permission|执行命令: rm -rf /tmp/x");
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  test("session-idle 优先于 permission（实际逻辑里 permissionDesc 在 sessionIdleDesc 存在时强制为 null）", () => {
    // computeModalKey 本身只看入参；实际调用方在 sessionIdle 命中时会把
    // permissionDesc 设 null。这里测函数本身的优先序：sessionIdle 优先。
    expect(computeModalKey("session 描述", "perm 描述")).toBe("session-idle");
  });
});

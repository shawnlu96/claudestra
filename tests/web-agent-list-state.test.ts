/**
 * list-recovery-AGL2：会话列表加载状态的纯逻辑（web/features/chat/agent-list-state.ts）。
 * DOM 级回归（慢 / 失败 / 重试 / 空 / 旧列表 / 过期响应 / 卸载）见 tests/web-dom-agent-list-recovery.test.ts。
 */
import { describe, expect, test } from "bun:test";
import {
  BACKOFF_CAP_MS, INITIAL_AGENT_LIST, agentListView, backoffMs, fail, isDeniedError, keepRosterOrder, markSlow, shouldRequest, startRequest, succeed,
} from "../web/features/chat/agent-list-state";

const NOW = 1_000_000;

describe("backoffMs", () => {
  test("指数增长、封顶 30s，jitter 落在 [一半, 全额]", () => {
    expect(backoffMs(1, 0)).toBe(1_000);
    expect(backoffMs(1, 1)).toBe(2_000);
    expect(backoffMs(2, 1)).toBe(4_000);
    for (let n = 1; n < 40; n++) for (const r of [0, 0.3, 1]) {
      expect(backoffMs(n, r)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      expect(backoffMs(n, r)).toBeGreaterThanOrEqual(1_000);
    }
    expect(backoffMs(30, 0)).toBe(BACKOFF_CAP_MS / 2);
  });
  test("越界 rand 被夹住", () => {
    expect(backoffMs(1, -5)).toBe(1_000);
    expect(backoffMs(1, 9)).toBe(2_000);
  });
});

describe("状态迁移", () => {
  test("失败排重试、连败累加；成功清零", () => {
    const a = fail(startRequest(INITIAL_AGENT_LIST, "action"), new Error("net"), NOW, 1);
    expect(a).toMatchObject({ phase: "failed", failures: 1, retryAt: NOW + 2_000, loaded: false, denied: false });
    const b = fail(startRequest(a, "poll"), new Error("net"), NOW, 1);
    expect(b.failures).toBe(2);
    expect(succeed(b)).toMatchObject({ phase: "ok", loaded: true, failures: 0, retryAt: null });
  });
  test("401 / 403 = denied，不排重试", () => {
    expect(isDeniedError({ status: 401 })).toBe(true);
    expect(isDeniedError({ status: 403 })).toBe(true);
    expect(isDeniedError({ status: 503 })).toBe(false);
    expect(isDeniedError(null)).toBe(false);
    expect(fail(INITIAL_AGENT_LIST, { status: 403 }, NOW, 0)).toMatchObject({ denied: true, retryAt: null });
  });
  test("markSlow 只作用于在途", () => {
    expect(markSlow(startRequest(INITIAL_AGENT_LIST, "action")).slow).toBe(true);
    expect(markSlow(INITIAL_AGENT_LIST).slow).toBe(false);
  });
});

describe("shouldRequest", () => {
  const backing = fail(INITIAL_AGENT_LIST, new Error("x"), NOW, 1);
  test("轮询尊重退避，事件 / 手动 / 操作可提前", () => {
    expect(shouldRequest(backing, "poll", NOW + 1)).toBe(false);
    expect(shouldRequest(backing, "poll", NOW + 2_000)).toBe(true);
    expect(shouldRequest(backing, "event", NOW + 1)).toBe(true);
    expect(shouldRequest(backing, "manual", NOW + 1)).toBe(true);
    expect(shouldRequest(INITIAL_AGENT_LIST, "poll", NOW)).toBe(true);
  });
  test("denied 后只有用户动手才再发", () => {
    const d = fail(INITIAL_AGENT_LIST, { status: 401 }, NOW, 0);
    expect(shouldRequest(d, "poll", NOW + 1e9)).toBe(false);
    expect(shouldRequest(d, "event", NOW)).toBe(false);
    expect(shouldRequest(d, "manual", NOW)).toBe(true);
  });
});

describe("agentListView：只有成功拿到的空列表才是空态", () => {
  const loading = startRequest(INITIAL_AGENT_LIST, "action");
  const failed = fail(loading, new Error("x"), NOW, 0);
  test.each([
    ["未请求", INITIAL_AGENT_LIST, 0, "waiting"],
    ["首拉中", loading, 0, "waiting"],
    ["首拉慢", markSlow(loading), 0, "slow"],
    ["首拉失败", failed, 0, "retrying"],
    ["首拉失败后手动重试在途", startRequest(failed, "manual"), 0, "retrying"],
    ["首拉被拒", fail(loading, { status: 403 }, NOW, 0), 0, "denied"],
    ["成功空", succeed(loading), 0, "empty"],
    ["成功有列表", succeed(loading), 3, "list"],
    ["有列表后刷新中", startRequest(succeed(loading), "poll"), 3, "list"],
    ["有列表后刷新失败", fail(succeed(loading), new Error("x"), NOW, 0), 3, "stale"],
    ["空列表后刷新失败（不说暂无会话）", fail(succeed(loading), new Error("x"), NOW, 0), 0, "stale"],
  ] as const)("%s", (_n, s, count, view) => {
    expect(agentListView(s, count)).toBe(view);
  });
});

test("keepRosterOrder：字段取新、顺序按旧，新增排尾", () => {
  const prev = [{ name: "b", v: 1 }, { name: "a", v: 1 }];
  const next = [{ name: "a", v: 2 }, { name: "c", v: 2 }, { name: "b", v: 2 }];
  expect(keepRosterOrder(prev, next)).toEqual([{ name: "b", v: 2 }, { name: "a", v: 2 }, { name: "c", v: 2 }]);
});

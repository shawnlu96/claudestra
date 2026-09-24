import { afterEach, describe, expect, test } from "bun:test";
import {
  UPDATE_HINT_DISMISS_KEY,
  dismissUpdateHint,
  getDismissedHints,
  resetDismissedHintsCache,
  subscribeDismissedHints,
  updateHintKey,
} from "../web/features/chat/update-hint-dismiss";

const g = globalThis as unknown as { localStorage?: unknown };
function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
afterEach(() => {
  delete g.localStorage;
  resetDismissedHintsCache();
});

describe("updateHintKey", () => {
  test("重启提示按 agent + 新版本号记：关 A 不影响 B，装了更新的版本会再提示", () => {
    const h = { kind: "restart", running: "2.1.280", installed: "2.1.281" } as const;
    expect(updateHintKey("a", h)).toBe("a:restart:2.1.281");
    expect(updateHintKey("b", h)).not.toBe(updateHintKey("a", h));
    expect(updateHintKey("a", { ...h, installed: "2.1.282" })).not.toBe(updateHintKey("a", h));
  });
  test("「Pi 可更新」只按最新版本号记：关一次覆盖所有 Pi 会话", () => {
    const h = { kind: "pi-update", installed: "0.86.1", latest: "0.87.1" } as const;
    expect(updateHintKey("p1", h)).toBe("pi-update:0.87.1");
    expect(updateHintKey("p2", { ...h, installed: "0.85.0" })).toBe(updateHintKey("p1", h));
  });
});

describe("关闭记录的持久化", () => {
  test("关掉的写进 localStorage，刷新（清内存缓存）后仍在；通知订阅者", () => {
    const s = fakeStorage();
    g.localStorage = s;
    let notified = 0;
    const off = subscribeDismissedHints(() => notified++);
    const before = getDismissedHints();
    dismissUpdateHint("a:restart:2.1.281");
    off();
    expect(notified).toBe(1);
    expect(getDismissedHints()).not.toBe(before); // 快照引用换新，React 才会重渲
    expect(JSON.parse(s.m.get(UPDATE_HINT_DISMISS_KEY)!)).toEqual(["a:restart:2.1.281"]);
    resetDismissedHintsCache();
    expect(getDismissedHints().has("a:restart:2.1.281")).toBe(true);
  });
  test("没有 / 抛错的 localStorage：照样能关（本页内有效），不抛", () => {
    g.localStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(getDismissedHints().size).toBe(0);
    dismissUpdateHint("k");
    expect(getDismissedHints().has("k")).toBe(true);
    delete g.localStorage;
    resetDismissedHintsCache();
    expect(getDismissedHints().size).toBe(0);
  });
  test("存储内容损坏 → 当作都没关过", () => {
    g.localStorage = fakeStorage({ [UPDATE_HINT_DISMISS_KEY]: "{not json" });
    expect(getDismissedHints().size).toBe(0);
  });
});

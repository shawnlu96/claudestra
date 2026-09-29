import { beforeEach, describe, expect, test } from "bun:test";
import {
  EMPTY_FOLD,
  FOLD_KEY_PREFIX,
  foldAll,
  foldOne,
  getFold,
  isFolded,
  loadFoldAll,
  resetFoldStates,
  saveFoldAll,
  setFoldAll,
  setFoldOne,
  subscribeFold,
  type MinimalStorage,
} from "@/features/chat/narration-fold";

function fakeStorage(init: Record<string, string> = {}): MinimalStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("旁白收起 / 展开：纯状态", () => {
  test("默认：普通旁白展开，紧跟 reply 的旁白收起", () => {
    expect(isFolded(EMPTY_FOLD, "m1:0")).toBe(false);
    expect(isFolded(EMPTY_FOLD, "m1:0", true)).toBe(true);
  });
  test("按过「展开全部 / 收起全部」就不再区分；单块覆盖优先", () => {
    expect(isFolded(foldAll(EMPTY_FOLD, false), "m1:0", true)).toBe(false);
    expect(isFolded(foldAll(EMPTY_FOLD, true), "m1:0", false)).toBe(true);
    expect(isFolded(foldOne(EMPTY_FOLD, "m1:0", false), "m1:0", true)).toBe(false);
  });
  test("单块覆盖只影响自己", () => {
    const s = foldOne(EMPTY_FOLD, "m1:0", true);
    expect(isFolded(s, "m1:0")).toBe(true);
    expect(isFolded(s, "m1:1")).toBe(false);
  });
  test("收起全部：后来的块继承，之前的单块覆盖清空", () => {
    const s = foldAll(foldOne(EMPTY_FOLD, "m1:0", false), true);
    expect(s.overrides).toEqual({});
    expect(isFolded(s, "m1:0")).toBe(true);
    expect(isFolded(s, "m9:3")).toBe(true);
  });
  test("全部收起后单块可再展开，其它仍收起", () => {
    const s = foldOne(foldAll(EMPTY_FOLD, true), "m1:0", false);
    expect(isFolded(s, "m1:0")).toBe(false);
    expect(isFolded(s, "m1:1")).toBe(true);
  });
  test("不改原对象", () => {
    const s = foldOne(EMPTY_FOLD, "k", true);
    expect(EMPTY_FOLD.overrides).toEqual({});
    expect(s).not.toBe(EMPTY_FOLD);
  });
});

describe("旁白收起：按 agent 持久化", () => {
  test("读写 localStorage 键", () => {
    const st = fakeStorage();
    expect(loadFoldAll(st, "agent-a")).toBeNull();
    saveFoldAll(st, "agent-a", false);
    expect(loadFoldAll(st, "agent-a")).toBe(false); // 明确按过「展开全部」
    saveFoldAll(st, "agent-a", true);
    expect(st.data[FOLD_KEY_PREFIX + "agent-a"]).toBe("1");
    expect(loadFoldAll(st, "agent-a")).toBe(true);
    expect(loadFoldAll(st, "agent-b")).toBeNull();
  });
  test("没有 storage / 空 agent → 默认（null），不抛", () => {
    expect(loadFoldAll(null, "agent-a")).toBeNull();
    expect(loadFoldAll(fakeStorage(), "")).toBeNull();
    expect(() => saveFoldAll(null, "agent-a", true)).not.toThrow();
  });
  test("storage 抛错也当默认", () => {
    const bad: MinimalStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(loadFoldAll(bad, "agent-a")).toBeNull();
    expect(() => saveFoldAll(bad, "agent-a", true)).not.toThrow();
  });
});

describe("旁白收起：模块级状态 + 订阅", () => {
  beforeEach(() => resetFoldStates());
  test("按 agent 隔离，空 agent 恒为默认", () => {
    setFoldAll("agent-a", true);
    expect(getFold("agent-a").all).toBe(true);
    expect(getFold("agent-b").all).toBeNull();
    expect(getFold("")).toBe(EMPTY_FOLD);
  });
  test("每次 set 都通知订阅者，退订后不再通知", () => {
    let n = 0;
    const off = subscribeFold(() => n++);
    setFoldOne("agent-a", "k", true);
    setFoldAll("agent-a", false);
    expect(n).toBe(2);
    off();
    setFoldOne("agent-a", "k", false);
    expect(n).toBe(2);
  });
  test("getFold 同一 agent 未变时返回同一引用（useSyncExternalStore 需要稳定快照）", () => {
    const a = getFold("agent-a");
    expect(getFold("agent-a")).toBe(a);
    setFoldOne("agent-a", "k", true);
    expect(getFold("agent-a")).not.toBe(a);
  });
});

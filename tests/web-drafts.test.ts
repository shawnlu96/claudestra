import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DRAFT_KEY_PREFIX,
  clearDraft,
  draftKey,
  hasDraft,
  loadDraft,
  readDraft,
  saveDraft,
  setDraftStorage,
  subscribeDrafts,
  writeDraft,
  type MinimalStorage,
} from "@/features/chat/drafts";

function fakeStorage(): MinimalStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe("草稿：纯读写", () => {
  test("键名按 agent", () => {
    expect(draftKey("agent-a")).toBe(DRAFT_KEY_PREFIX + "agent-a");
  });
  test("有内容才存，空白即删", () => {
    const st = fakeStorage();
    writeDraft(st, "agent-a", "hello");
    expect(readDraft(st, "agent-a")).toBe("hello");
    writeDraft(st, "agent-a", "   \n");
    expect(readDraft(st, "agent-a")).toBe("");
    expect(st.data).toEqual({});
  });
  test("没有 storage / 空 agent → 空串，不抛", () => {
    expect(readDraft(null, "agent-a")).toBe("");
    expect(readDraft(fakeStorage(), "")).toBe("");
    expect(() => writeDraft(null, "agent-a", "x")).not.toThrow();
  });
  test("storage 抛错当没草稿", () => {
    const bad: MinimalStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readDraft(bad, "agent-a")).toBe("");
    expect(() => writeDraft(bad, "agent-a", "x")).not.toThrow();
  });
});

describe("草稿：模块级 store + 订阅（侧栏标记的数据源）", () => {
  let st: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    st = fakeStorage();
    setDraftStorage(st);
  });
  afterEach(() => setDraftStorage(undefined));

  test("hasDraft / loadDraft / clearDraft", () => {
    expect(hasDraft("agent-a")).toBe(false);
    saveDraft("agent-a", "草稿");
    expect(hasDraft("agent-a")).toBe(true);
    expect(loadDraft("agent-a")).toBe("草稿");
    expect(hasDraft("agent-b")).toBe(false);
    clearDraft("agent-a");
    expect(hasDraft("agent-a")).toBe(false);
  });
  test("只在「有 ↔ 无」翻转时通知，随打随存不刷侧栏", () => {
    let n = 0;
    const off = subscribeDrafts(() => n++);
    saveDraft("agent-a", "a");
    expect(n).toBe(1);
    saveDraft("agent-a", "ab");
    saveDraft("agent-a", "abc");
    expect(n).toBe(1);
    saveDraft("agent-a", "");
    expect(n).toBe(2);
    saveDraft("agent-a", "   ");
    expect(n).toBe(2);
    off();
    saveDraft("agent-a", "x");
    expect(n).toBe(2);
  });
  test("没有 storage 时一切静默为「无草稿」", () => {
    setDraftStorage(null);
    saveDraft("agent-a", "x");
    expect(hasDraft("agent-a")).toBe(false);
    expect(loadDraft("agent-a")).toBe("");
  });
});

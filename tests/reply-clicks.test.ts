/**
 * reply 组件「按行独立作答」的纯逻辑单测(bug ① 修复,2026-08-24)。
 *
 * 旧模型 replyClickedId 是消息级单值,一条 reply 多行时答一行锁全部、且存不下
 * 多行答案。这里锁住 rowKey 的两侧一致性 + 历史还原能收全每一行的点击。
 */
import { describe, test, expect } from "bun:test";
import {
  replyRowKey,
  matchClickedRow,
  deriveClicksFromLegacy,
} from "../web/lib/chat/reply-clicks.js";

const rows: any[] = [
  { type: "buttons", buttons: [{ id: "ok", label: "确认" }, { id: "no", label: "取消" }] },
  { type: "select", id: "sev", placeholder: "严重度", options: [{ label: "高", value: "hi" }, { label: "低", value: "lo" }] },
  { type: "multiselect", id: "tags", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }] },
];

describe("replyRowKey", () => {
  test("buttons 按下标、select/multiselect 按 id + 类型前缀", () => {
    expect(replyRowKey(rows[0], 0)).toBe("b0");
    expect(replyRowKey(rows[1], 1)).toBe("s:sev");
    expect(replyRowKey(rows[2], 2)).toBe("m:tags");
  });
  test("两个 buttons 行下标区分开", () => {
    expect(replyRowKey({ type: "buttons", buttons: [] }, 0)).toBe("b0");
    expect(replyRowKey({ type: "buttons", buttons: [] }, 3)).toBe("b3");
  });
});

describe("matchClickedRow", () => {
  test("按钮点击 → 定位 buttons 行", () => {
    expect(matchClickedRow(rows, "ok", null, null)).toEqual({ rowKey: "b0", choiceValue: "ok", label: "确认" });
  });
  test("select 点击 → 行 + `<id>:<值>` + label", () => {
    expect(matchClickedRow(rows, null, "sev", "hi")).toEqual({ rowKey: "s:sev", choiceValue: "sev:hi", label: "高" });
  });
  test("multiselect 逗号值 → 拼 label、拼值", () => {
    expect(matchClickedRow(rows, null, "tags", "a,c")).toEqual({ rowKey: "m:tags", choiceValue: "tags:a,c", label: "A、C" });
  });
  test("多行各自命中的是不同的 rowKey(修复的核心)", () => {
    const a = matchClickedRow(rows, "ok", null, null)!;
    const b = matchClickedRow(rows, null, "sev", "lo")!;
    expect(a.rowKey).not.toBe(b.rowKey); // 答完按钮行不该把 select 行也算进同一格
  });
  test("查不到 → null(未知 id / 空 rows)", () => {
    expect(matchClickedRow(rows, "zzz", null, null)).toBeNull();
    expect(matchClickedRow(rows, null, "sev", "nope")).toBeNull();
    expect(matchClickedRow(undefined, "ok", null, null)).toBeNull();
  });
});

describe("deriveClicksFromLegacy（老快照兼容）", () => {
  test("按钮单值 → 对应行", () => {
    expect(deriveClicksFromLegacy("ok", rows)).toEqual({ b0: "ok" });
  });
  test("select `<id>:<值>` 单值 → 对应行", () => {
    expect(deriveClicksFromLegacy("sev:hi", rows)).toEqual({ "s:sev": "sev:hi" });
  });
  test("multiselect 单值 → 对应行", () => {
    expect(deriveClicksFromLegacy("tags:a,b", rows)).toEqual({ "m:tags": "tags:a,b" });
  });
  test("空 / 查不到 → 空对象(退化成都没答,不全锁死)", () => {
    expect(deriveClicksFromLegacy(undefined, rows)).toEqual({});
    expect(deriveClicksFromLegacy("unknown", rows)).toEqual({});
    expect(deriveClicksFromLegacy("ok", undefined)).toEqual({});
  });
});

// 端到端一致性:点击时(row,ri)算的 key === 历史还原(rows,wire)算的 key
describe("rowKey 两侧一致(点击时 vs 历史还原)", () => {
  test("三种行都对得上", () => {
    for (let ri = 0; ri < rows.length; ri++) {
      const clickKey = replyRowKey(rows[ri], ri);
      const wire =
        rows[ri].type === "buttons"
          ? matchClickedRow(rows, "ok", null, null)
          : rows[ri].type === "select"
            ? matchClickedRow(rows, null, "sev", "hi")
            : matchClickedRow(rows, null, "tags", "a");
      if (ri === 0) expect(wire!.rowKey).toBe(clickKey);
      if (ri === 1) expect(wire!.rowKey).toBe(clickKey);
      if (ri === 2) expect(wire!.rowKey).toBe(clickKey);
    }
  });
});

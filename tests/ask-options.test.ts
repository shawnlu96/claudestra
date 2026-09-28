/** reply → ask 草稿、wire 与选项互认（lib/ask-options.ts） */
import { describe, expect, test } from "bun:test";
import { draftFromReply, matchWire, splitWire, type AskRow } from "../src/lib/ask-options.js";

const rows: AskRow[] = [
  { type: "buttons", buttons: [{ id: "release_v2_go", label: "✅ **发**" }, { id: "cancel", label: "取消" }] },
  { type: "select", id: "pick", options: [{ label: "甲", value: "a" }, { label: "乙", value: "b" }] },
  { type: "multiselect", id: "m:x", options: [{ label: "一", value: "1" }, { label: "二", value: "2" }, { label: "三", value: "3" }], min: 1, max: 2 },
];

describe("draftFromReply", () => {
  test("没有能点的 → null（纯文本、空 components、形状不对的行都不算）", () => {
    expect(draftFromReply("只是知会", undefined)).toBeNull();
    expect(draftFromReply("x", [])).toBeNull();
    expect(draftFromReply("x", [{ type: "buttons", buttons: [] }, { type: "weird" }, "s"])).toBeNull();
  });

  test("标题 = 去 Markdown 后的第一行（≤40 字），背景 = 前 300 字；按钮 id 前缀只给「可能是授权」的提示", () => {
    const long = "**v2.31.0** 已经 commit，要发吗？\n\n" + "细节".repeat(200);
    const d = draftFromReply(long, rows)!;
    expect(d.title).toBe("v2.31.0 已经 commit，要发吗？");
    expect(Array.from(d.context).length).toBe(300);
    expect(d.kindHint).toBe("authorize");
    expect(draftFromReply("选一个", [rows[1]])!.kindHint).toBeNull();
  });

  test("正文里的行内按钮也算选项，排在 components 之后；按钮在标题里显示成 [文字]", () => {
    const d = draftFromReply("[[{#fwd_ok .primary}转过去]]", undefined)!;
    expect(d.options).toEqual([{ type: "buttons", buttons: [{ id: "fwd_ok", label: "转过去", style: "primary" }] }]);
    expect(d.title).toBe("[转过去]");
  });
});

describe("matchWire", () => {
  test("按钮：id 对上给出去掉样式的 label；不在选项里 → null", () => {
    expect(matchWire(rows, "[button:release_v2_go]")).toEqual({ wire: "[button:release_v2_go]", label: "✅ 发" });
    expect(matchWire(rows, "[button:nope]")).toBeNull();
  });

  test("单选只收一个值；多选按 min / max 与去重；id 带冒号也能认", () => {
    expect(matchWire(rows, "[select:pick:b]")).toEqual({ wire: "[select:pick:b]", label: "乙" });
    expect(matchWire(rows, "[select:pick:a,b]")).toBeNull();
    expect(matchWire(rows, "[select:pick:z]")).toBeNull();
    expect(matchWire(rows, "[select:m:x:1, 3]")).toEqual({ wire: "[select:m:x:1,3]", label: "一、三" });
    expect(matchWire(rows, "[select:m:x:1,2,3]")).toBeNull();
    expect(matchWire(rows, "[select:m:x:1,1]")).toBeNull();
  });
});

test("splitWire：单独成行的 wire 与其余文字分开（输入框表单同步发送 = wire 行 + 补充）", () => {
  expect(splitWire("> 引用\n\n[select:pick:a]\n  [button:cancel]  \n顺便说一句")).toEqual({ wires: ["[select:pick:a]", "[button:cancel]"], rest: "> 引用\n\n顺便说一句" });
  expect(splitWire("我觉得 [button:x] 不对")).toEqual({ wires: [], rest: "我觉得 [button:x] 不对" });
});

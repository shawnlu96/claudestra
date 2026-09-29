/** Chat 入口默认收起（T50，web/lib/talk-gate.ts）：开关关时侧栏不出切换、/talk 跳回工作台；没读到时两边都先不动 */
import { describe, expect, test } from "bun:test";
import { showWorkspaceSwitch, talkEnabledOf, talkOnFor, talkRedirect } from "../web/lib/talk-gate";

describe("talk-gate", () => {
  test("开关关（缺省）：切换不出现，/talk 跳回 /chat", () => {
    expect(showWorkspaceSwitch(false)).toBe(false);
    expect(talkRedirect(false)).toBe("/chat");
  });
  test("开关开：切换出现，/talk 不跳", () => {
    expect(showWorkspaceSwitch(true)).toBe(true);
    expect(talkRedirect(true)).toBeNull();
  });
  test("还没读到：先显示原来的标题、也不跳（开着的人不会被弹走）", () => {
    expect(showWorkspaceSwitch(null)).toBe(false);
    expect(talkRedirect(null)).toBeNull();
  });
  test("回包：只有 talkEnabled === true 才算开；老 bridge 没字段、读失败、写成字符串都按关", () => {
    expect(talkEnabledOf({ talkEnabled: true })).toBe(true);
    for (const j of [{}, null, undefined, { talkEnabled: "true" }, { talkEnabled: 1 }]) expect(talkEnabledOf(j as never)).toBe(false);
  });
  test("切机器（T50 复核 P2）：从开着 Chat 的 A 切到 B，B 的设置回来之前不沿用 A 的 true——不挂 Chat、也不跳走；回来后按 B 的", () => {
    const fromA = { fp: "A", on: true };
    expect(talkOnFor(fromA, "A")).toBe(true);
    const onB = talkOnFor(fromA, "B");
    expect(onB).toBeNull();
    expect(showWorkspaceSwitch(onB)).toBe(false);
    expect(talkRedirect(onB)).toBeNull();
    expect(talkOnFor({ fp: "B", on: false }, "B")).toBe(false);
    expect(talkOnFor(null, "A")).toBeNull();
  });
});

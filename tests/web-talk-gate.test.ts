/** Chat 入口默认收起（T50，web/lib/talk-gate.ts）：开关关时侧栏不出切换、/talk 跳回工作台；没读到时两边都先不动 */
import { describe, expect, test } from "bun:test";
import { showWorkspaceSwitch, talkEnabledOf, talkRedirect } from "../web/lib/talk-gate";

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
});

import { expect, test } from "bun:test";
import { isAskForAudience } from "../src/lib/ask-audience";
import { isAskForAudience as webAudience } from "@/features/asks/ask-audience";

test("PM 的执行者 / 审查员提问只属于 PM；权限能代答不等于收件人", () => {
  const ask = { fromAgent: "agent-lend-x@Sekai", assignee: "agent-claudestra", kind: "decide", state: "open", canAnswer: true };
  expect(isAskForAudience(ask)).toBe(false);
  expect(isAskForAudience(ask, ["agent-claudestra"])).toBe(true);
  expect(isAskForAudience(ask, ["agent-other"])).toBe(false);
});

test("owner / 未指派兼容旧数据，guest 只收自己的；web twin 同矩阵", () => {
  for (const fn of [isAskForAudience, webAudience]) {
    for (const assignee of [undefined, null, "", "local:owner:self"]) {
      expect(fn({ assignee })).toBe(true);
      expect(fn({ assignee }, ["local:guest:abc"])).toBe(false);
    }
    for (const assignee of ["agent-claudestra", "agent-pm@Sekai", "Sekai/agent-pm", "local:guest:abc"]) {
      expect(fn({ assignee })).toBe(false);
      expect(fn({ assignee }, [assignee])).toBe(true);
    }
    expect(fn({ assignee: "local:guest:old" }, ["local:guest:new", "local:guest:old"])).toBe(true);
  }
});

test("历史上没 assignee 的 priorityStall 提醒按 extra.pm 收件；只认这一种，owner 授权卡不受影响", () => {
  for (const fn of [isAskForAudience, webAudience]) {
    const stall = { assignee: null, extra: { mechanism: "priorityStall", pm: "agent-claudestra" } };
    expect(fn(stall)).toBe(false);
    expect(fn(stall, ["agent-claudestra"])).toBe(true);
    expect(fn({ assignee: "local:owner:self", extra: stall.extra })).toBe(true);
    for (const extra of [{ mechanism: "priorityStall" }, { mechanism: "priorityStall", pm: "" }, { mechanism: "other", pm: "agent-claudestra" },
      { pm: "agent-claudestra" }, {}, null, undefined]) {
      expect(fn({ assignee: null, extra })).toBe(true);
    }
  }
});

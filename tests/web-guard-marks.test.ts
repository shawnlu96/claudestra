/** 本端气泡的守门标记（web/features/chat/guard-marks.ts，Codex 复审）：按 messageId 认气泡；事件与发送回执谁先到都不标错 */
import { describe, expect, test } from "bun:test";
import { createGuardMarks } from "@/features/chat/guard-marks";

describe("createGuardMarks", () => {
  test("回执先到：等放行；之后丢弃 → 已丢弃；放行 → 标记消掉", () => {
    const m = createGuardMarks();
    m.sent("api_1", "b1");
    expect(m.of("b1")).toBe("held");
    m.event("api_1", "dropped");
    expect(m.of("b1")).toBe("dropped");
    m.sent("api_2", "b2");
    m.event("api_2", "released");
    expect(m.of("b2")).toBeNull();
  });
  test("事件先到（另一台设备先丢弃了）：回执到了直接是「已丢弃」，不被盖回「等放行」", () => {
    const m = createGuardMarks();
    m.event("api_3", "dropped");
    m.sent("api_3", "b3");
    expect(m.of("b3")).toBe("dropped");
    m.event("api_4", "released");
    m.sent("api_4", "b4");
    expect(m.of("b4")).toBeNull();
  });
  test("同文的两条各认各的；没对上回执的事件不影响任何气泡", () => {
    const m = createGuardMarks();
    m.sent("api_5", "b5");
    m.sent("api_6", "b6");
    m.event("api_5", "dropped");
    expect([m.of("b5"), m.of("b6")]).toEqual(["dropped", "held"]);
    m.event("api_other", "quarantined");
    expect(m.of("api_other")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_GRACE_MS, RESUME_DELAY_MS, RESUME_WINDOW_MS, countsAsActivity, dueForResume, markResumed, noteActivity, noteApiError, resumeText,
  type ApiErrorState,
} from "../src/lib/api-error-resume.js";

const T0 = 1_000_000;

describe("api-error-resume", () => {
  test("错误后 60s 无活动 ⇒ 到期续跑；续跑只标一次", () => {
    const m = new Map<string, ApiErrorState>();
    expect(noteApiError(m, "c1", "server_error", T0)).toBe("track");
    expect(dueForResume(m, T0 + RESUME_DELAY_MS - 1)).toEqual([]);
    expect(dueForResume(m, T0 + RESUME_DELAY_MS)).toEqual(["c1"]);
    markResumed(m, "c1", T0 + RESUME_DELAY_MS);
    expect(dueForResume(m, T0 + RESUME_DELAY_MS + 5_000)).toEqual([]);
  });

  test("错误后有新活动（时间晚于错误）⇒ 不续", () => {
    const m = new Map<string, ApiErrorState>();
    noteApiError(m, "c1", "e", T0);
    noteActivity(m, "c1", T0 - 1); // watcher 补读到的旧条目不算
    expect(m.has("c1")).toBe(true);
    noteActivity(m, "c1", T0 + 1); // 错误条目自己连带的 assistant_text / thinking，几毫秒后
    expect(m.has("c1")).toBe(true);
    noteActivity(m, "c1", T0 + ACTIVITY_GRACE_MS + 1);
    expect(m.has("c1")).toBe(false);
    expect(dueForResume(m, T0 + RESUME_DELAY_MS)).toEqual([]);
  });

  test("续跑之后窗口内再撞 ⇒ escalate 且不再续；窗口过了当新一次", () => {
    const m = new Map<string, ApiErrorState>();
    noteApiError(m, "c1", "e", T0);
    markResumed(m, "c1", T0 + RESUME_DELAY_MS);
    noteActivity(m, "c1", T0 + RESUME_DELAY_MS + 1); // 续跑后的活动不删记录
    expect(m.has("c1")).toBe(true);
    expect(noteApiError(m, "c1", "e", T0 + RESUME_DELAY_MS + 30_000)).toBe("escalate");
    expect(m.has("c1")).toBe(false);
    noteApiError(m, "c2", "e", T0);
    markResumed(m, "c2", T0);
    expect(dueForResume(m, T0 + RESUME_WINDOW_MS)).toEqual([]);
    expect(m.has("c2")).toBe(false); // 过期清掉
    expect(noteApiError(m, "c2", "e", T0 + RESUME_WINDOW_MS + 1)).toBe("track");
  });

  test("错误条目自己那句 API Error 文本不算活动；工具调用 / thinking / 用户消息算", () => {
    expect(countsAsActivity("assistant_text", { text: "API Error: Unable to connect to API (X)" })).toBe(false);
    expect(countsAsActivity("assistant_text", { text: "继续做 §24.1" })).toBe(true);
    expect(countsAsActivity("tool_start", {})).toBe(true);
    expect(countsAsActivity("chat_message", {})).toBe(true);
    expect(countsAsActivity("agent_status", { status: "thinking" })).toBe(true);
    expect(countsAsActivity("agent_status", { status: "done" })).toBe(false);
    expect(countsAsActivity("turn_duration", {})).toBe(false);
  });

  test("续跑文案带错误名与时间，并允许无事可做时 end_turn", () => {
    const t = resumeText("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", T0);
    expect(t).toContain("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR");
    expect(t).toContain("end_turn");
    expect(t.startsWith("[⚠️ api-error-resume]")).toBe(true);
  });
});

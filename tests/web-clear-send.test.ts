import { expect, test } from "bun:test";
import { canSendClearBoot, classifySendFailure, isClearSend, RetiredAcpStreams, sendTimeoutMs, settleClearSend } from "../web/features/chat/clear-send";

test("Web /clear waits for rotation and an uncertain result cannot offer one-click retry", () => {
  expect(isClearSend("/clear", false)).toBe(true);
  expect(isClearSend("/clear now", false)).toBe(true);
  expect(isClearSend("/clear", true)).toBe(false);
  expect(sendTimeoutMs(true, false)).toBe(230_000);
  expect(sendTimeoutMs(false, true)).toBe(60_000);
  expect(sendTimeoutMs(false, false)).toBe(20_000);

  const unknown = classifySendFailure({ code: "clear_result_unknown" }, true, "zh", String);
  expect(unknown).toMatchObject({ handled: true, unknown: true });
  expect(unknown.text).toContain("/clear");
  expect(classifySendFailure(new DOMException("expired", "TimeoutError"), true, "zh", String).unknown).toBe(true);
  expect(classifySendFailure({ code: "busy" }, true, "zh", String).unknown).toBe(false);
});

test("confirmed clear removes the old view and cached thread", () => {
  const cache = new Map<string, unknown>([["agent-a", ["old"]]]);
  const state: { activeAgent: string; messages: { id: string }[]; pendingPermission: string | null; pendingAsk: string | null; streaming: boolean; awaitingChunk: boolean } =
    { activeAgent: "agent-a", messages: [{ id: "old" }, { id: "clear" }, { id: "queued-human" }], pendingPermission: "card", pendingAsk: "ask", streaming: true, awaitingChunk: true };
  const retired = new RetiredAcpStreams();
  settleClearSend(cache, "agent-a", "clear", retired, "old-session")(state);
  expect(retired.shouldDrop("agent-a", "acp:old-session")).toBe(true);
  expect(retired.shouldDrop("agent-a", "acp:new-session")).toBe(false);
  expect(cache.has("agent-a")).toBe(false);
  expect(state).toEqual({ activeAgent: "agent-a", messages: [{ id: "queued-human" }], pendingPermission: null, pendingAsk: null, streaming: false, awaitingChunk: false });
});

test("clear completing after switching agents leaves the new active chat alone", () => {
  const cache = new Map<string, unknown>([["agent-a", ["old"]], ["agent-b", ["keep"]]]);
  const state = { activeAgent: "agent-b", messages: [{ id: "b-message" }], pendingPermission: "b-card",
    pendingAsk: "b-ask", streaming: true, awaitingChunk: true };
  const retired = new RetiredAcpStreams();
  settleClearSend(cache, "agent-a", "a-clear", retired, "old-session")(state);
  expect(retired.shouldDrop("agent-a", "acp:old-session")).toBe(true);
  expect(cache.has("agent-a")).toBe(false);
  expect(cache.get("agent-b")).toEqual(["keep"]);
  expect(state).toEqual({ activeAgent: "agent-b", messages: [{ id: "b-message" }], pendingPermission: "b-card",
    pendingAsk: "b-ask", streaming: true, awaitingChunk: true });
});

test("older session replay is fenced for either chat or clear-button rotation", () => {
  const retired = new RetiredAcpStreams();
  const cache = new Map<string, unknown>();
  const state = { activeAgent: "agent-a", messages: [{ id: "old" }], pendingPermission: null,
    pendingAsk: null, streaming: false, awaitingChunk: false };
  settleClearSend(cache, "agent-a", null, retired, "sid-before-button")(state);
  expect(state.messages).toEqual([]);
  expect(retired.shouldDrop("agent-a", "acp:sid-before-button")).toBe(true);
  expect(retired.shouldDrop("agent-b", "acp:sid-before-button")).toBe(false);
  expect(retired.shouldDrop("agent-a", "acp:later-session")).toBe(false);
});

test("clear button keeps human messages queued during rotation and never boots another agent", () => {
  const retired = new RetiredAcpStreams();
  const cache = new Map<string, unknown>();
  const start = Date.parse("2026-09-30T09:00:00Z");
  const state = { activeAgent: "agent-a", messages: [
    { id: "old-user", role: "user", ts: "2026-09-30T08:59:59Z" },
    { id: "queued-human", role: "user", ts: "2026-09-30T09:00:01Z" },
    { id: "old-output", role: "assistant", ts: "2026-09-30T09:00:02Z", sid: "acp:old" },
    { id: "new-output", role: "assistant", ts: "2026-09-30T09:00:03Z", sid: "acp:new" },
  ], pendingPermission: null, pendingAsk: null, streaming: false, awaitingChunk: false };
  settleClearSend(cache, "agent-a", null, retired, "old", start)(state);
  expect(state.messages.map((m) => m.id)).toEqual(["queued-human", "new-output"]);
  expect(canSendClearBoot("agent-a", "agent-a")).toBe(true);
  expect(canSendClearBoot("agent-b", "agent-a")).toBe(false);
});

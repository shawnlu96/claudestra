/** 「待你处理」推送规则表（lib/ask-push.ts，docs 13 §4.5 + owner 拍板：验收类不推） */
import { describe, expect, test } from "bun:test";
import { askPushDecision, askPushMessage } from "../src/lib/ask-push.js";

type Row = [string, Parameters<typeof askPushDecision>[0], "active" | "away", ReturnType<typeof askPushDecision>];
const open = { state: "open" as const, urgency: "normal" as const };
const TABLE: Row[] = [
  ["卡活 + owner 不在 → 推", { ...open, kind: "decide", blocking: true }, "away", "push"],
  ["卡活 + owner 在用 → 不推，发横幅", { ...open, kind: "authorize", blocking: true }, "active", "banner"],
  ["卡活 + 急 → 在不在都推", { ...open, kind: "owner_action", blocking: true, urgency: "urgent" }, "active", "push"],
  ["不卡活 → 不推", { ...open, kind: "decide", blocking: false }, "away", "none"],
  ["自动建的（不知道卡不卡活）→ 不额外推", { ...open, kind: "decide", blocking: null }, "away", "none"],
  ["验收类即使标了卡活也不推", { ...open, kind: "accept", blocking: true, urgency: "urgent" }, "away", "none"],
  ["已结案 → 不推", { state: "answered", urgency: "normal", kind: "decide", blocking: true }, "away", "none"],
];

describe("askPushDecision", () => {
  for (const [name, ask, presence, want] of TABLE) test(name, () => expect(askPushDecision(ask, presence)).toBe(want));
});

test("推送内容：点开直达卡片，tag 一条 ask 每个状态一个", () => {
  expect(askPushMessage({ id: "ask_1", fromAgent: "agent-x", title: "发吗", state: "open", kind: "decide" })).toMatchObject({ body: "发吗", url: "/chat?ask=ask_1", tag: "cstra-ask-ask_1-open" });
});

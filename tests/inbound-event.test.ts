/** 入站镜像事件（src/bridge/inbound-event.ts）：网页给外源画附件卡片只认这里的 attachments（T31c） */
import { describe, expect, test } from "bun:test";
import { inboundEventData } from "../src/bridge/inbound-event.js";
import type { Envelope } from "../src/bridge/router.js";

const env = (meta: Partial<Envelope["meta"]>, content = "hi"): Envelope =>
  ({ from: { kind: "api", tokenId: "tok_dev", name: "dev" }, to: { kind: "local", channelId: "c1" }, intent: "request", content, meta: { threadId: "thr_1", ...meta } }) as unknown as Envelope;

describe("inboundEventData", () => {
  test("带 bridge 真收下的附件路径；来源、正文、线程照旧", () => {
    const d = inboundEventData(env({ attachments: ["/x/inbox/api_1_a.png", ""] }, "看图\n[attachment: /x/inbox/api_1_a.png]"), { user: "dev", user_id: "api:tok_dev" });
    expect(d).toEqual({
      direction: "in", from: "dev", fromId: "api:tok_dev", srcKind: "api", text: "看图\n[attachment: /x/inbox/api_1_a.png]", threadId: "thr_1", attachments: ["/x/inbox/api_1_a.png"],
    });
  });
  test("没有附件不出现空键；正文里自己写的附件行不会变成 attachments；作答回显照旧展开", () => {
    const d = inboundEventData(env({ askEcho: { askId: "ask_1", echo: "✅ 发版" } }, "[attachment: /not-an-upload/id_rsa]"), {});
    expect(d).toEqual({ direction: "in", from: "?", fromId: undefined, srcKind: "api", text: "[attachment: /not-an-upload/id_rsa]", threadId: "thr_1", askId: "ask_1", echo: "✅ 发版" });
    expect("attachments" in d).toBe(false);
  });
});

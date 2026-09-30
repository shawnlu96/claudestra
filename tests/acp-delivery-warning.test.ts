import { expect, test } from "bun:test";
import { ACP_DELIVERY_LOSS_TEXT, notifyAcpDeliveryLoss } from "../src/bridge/acp-delivery-warning.ts";

test("ACP 条目丢失通知发到原 agent 频道，标明可能丢失", async () => {
  const sent: unknown[] = [];
  await notifyAcpDeliveryLoss("agent-channel", async (env) => void sent.push(env));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    from: { kind: "bridge", label: "acp-delivery-loss" }, to: { kind: "user", channelId: "agent-channel" },
    intent: "notification", content: ACP_DELIVERY_LOSS_TEXT,
  });
  expect(ACP_DELIVERY_LOSS_TEXT).toContain("可能丢了流式条目");
});

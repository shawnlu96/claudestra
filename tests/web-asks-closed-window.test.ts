/**
 * SYN-2 r1 P1 closed-window：bridge 默认列表只带 24 小时内结案的，网页气泡判「查不到 = 早已结案」也必须按 24 小时。
 * 两天前撤销的 decide ask：默认列表里没有它，聊天气泡上的按钮仍然锁住（blocked，点了不会当普通 [button:…] 发给 agent）。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setAsksForTest } from "../src/bridge/asks.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { closeAsk, openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { replyAskState, type WebAsk } from "@/features/asks/asks-model";
import type { WebComponentRow } from "@/lib/chat/events";
import { owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let path = "";
beforeEach(() => {
  path = tempLedgerPath("asks-window-");
  openLedger(path);
  const registry = [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent];
  const deps = { clients: new Map(), controlChannelId: "999", deliver: async (env: Envelope) => ({ envelope: env, outcome: { kind: "sent" as const } }), hold: () => {} };
  setAsksForTest({ path, registry, ownerChats: ["api:owner:self"], deps });
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

const rows: WebComponentRow[] = [{ type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] }];

test("两天前撤销的 decide ask：默认列表不带它，气泡按钮（带不带 askId 都）锁住", async () => {
  const now = Date.now();
  const twoDaysAgo = now - 2 * 86400_000;
  const db = openLedger(path);
  const a = openAsk(db, { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发吗", body: "发吗？", options: rows });
  closeAsk(db, a.id, "cancelled", "", twoDaysAgo);
  const res = (await handleAsksApi(new Request("http://x/api/v1/asks"), "/asks", owner()))!;
  const body = (await res.json()) as { asks: WebAsk[]; full: boolean };
  expect(body.full).toBe(true);
  expect(body.asks.map((x) => x.id)).not.toContain(a.id);
  const ts = new Date(twoDaysAgo).toISOString();
  for (const replyAskId of [a.id, undefined]) {
    const st = replyAskState(body.asks, "full", "agent-x", { replyComponents: rows, replyTs: ts, ts, replyAskId }, [], now);
    expect(st.gone).toBe(true);
    expect(st.blocked).toBe(true);
  }
});

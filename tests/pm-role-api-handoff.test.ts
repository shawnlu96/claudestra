import { afterEach, expect, test } from "bun:test";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { deliverPmLocal, followPmDelivery } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import type { Envelope, LocalEndpoint, Delivery } from "../src/bridge/router.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const socket = () => ({ send: () => {} }) as unknown as LocalEndpoint["ws"];

test("API redirect: typing, message source and handoff bookkeeping follow the active PM", async () => {
  const f = pmFixture(); fixtures.push(f);
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const state = await f.deps.read(), agent = { name: A, channelId: "channel-a" };
  const env: Envelope = { from: { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" },
    to: { kind: "local", agentName: A, channelId: "channel-a", ws: socket() }, intent: "request", content: "q",
    meta: { messageId: "api_1", triggerKind: "system", ts: "2026-01-01T00:00:00Z", threadId: "t" } };
  const send = async (e: Envelope): Promise<Delivery> => ({ envelope: e, outcome: { kind: "sent" } });
  const delivery = await deliverPmLocal(env, env.to as LocalEndpoint, new Map([["channel-b", { ws: socket() }]]), new AgentCallBook(null), new Map(), send,
    { db: f.db, agents: state.agents, principals: async () => ({ principals: state.principals }) });
  followPmDelivery(agent, delivery);
  expect(agent).toEqual({ name: B, channelId: "channel-b" });
  const direct = { name: B, channelId: "channel-b" };
  followPmDelivery(direct, { envelope: { ...env, to: { kind: "local", agentName: B, channelId: "channel-b", ws: socket() } } });
  expect(direct).toEqual({ name: B, channelId: "channel-b" });
});

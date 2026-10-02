import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHttpPeer } from "../src/bridge/http-peer.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { deliverPmLocal, pmClientFor } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import type { Envelope, LocalEndpoint, Delivery } from "../src/bridge/router.js";
import { A, B, D, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const fixture = () => { const f = pmFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const C = "agent-gamma";
const socket = (id: string) => ({ id, send: () => {} }) as unknown as LocalEndpoint["ws"];

async function routing(onlineA: boolean) {
  const f = fixture();
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const state = await f.deps.read();
  const agents = [...state.agents, { name: C, projectId: P, channelId: "channel-c" }];
  const clients = new Map<string, { ws: LocalEndpoint["ws"] }>([["channel-b", { ws: socket("b") }], ["channel-c", { ws: socket("c") }]]);
  if (onlineA) clients.set("channel-a", { ws: socket("a") });
  const sent: { to: LocalEndpoint; content: string }[] = [];
  const send = async (env: Envelope, to: LocalEndpoint): Promise<Delivery> => { sent.push({ to, content: env.content }); return { envelope: env, outcome: { kind: "sent" } }; };
  const facts = { db: f.db, agents, principals: async () => ({ principals: state.principals }) };
  const point = (agent: string) => {
    for (const [key, value] of [["activePm", agent], ["pms", [D, agent, ...[A, B, C].filter((p) => p !== agent)]]] as const) {
      f.db.query("INSERT INTO meta(project,key,value) VALUES(?,?,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value").run(P, key, JSON.stringify(value));
    }
  };
  const deliver = (env: Envelope) => deliverPmLocal(env, env.to as LocalEndpoint, clients, new AgentCallBook(null), new Map(), send, facts);
  return { f, clients, sent, facts, point, deliver };
}

function toA(messageId: string, extra: Partial<Envelope["meta"]> = {}, ws = socket("stale"), intent: Envelope["intent"] = "response"): Envelope {
  return { from: { kind: "local", agentName: "agent-task-1", channelId: "sender", ws: socket("sender") },
    to: { kind: "local", agentName: A, channelId: "channel-a", ws }, intent, content: "answer",
    meta: { messageId, triggerKind: "agent_tool", ts: "2026-01-01T00:00:00Z", threadId: "t", ...extra } };
}

test("former PM online receives the answer to its own send_to_agent unchanged", async () => {
  const r = await routing(true);
  for (const env of [toA("agent_reply_1_x"), toA("agent_drain_1_x"), toA("hp_call_reply", { triggerKind: "peer_http" })]) {
    env.to = { ...(env.to as LocalEndpoint), ws: r.clients.get("channel-a")!.ws };
    await r.deliver(env);
  }
  expect(r.sent.map((s) => [s.to.channelId, s.content])).toEqual([["channel-a", "answer"], ["channel-a", "answer"], ["channel-a", "answer"]]);
});

test("former PM offline: its answer goes to the active PM with a 'reply to former PM' header", async () => {
  const r = await routing(false);
  await r.deliver(toA("agent_reply_1_x"));
  await r.deliver(toA("hp_call_reply", { triggerKind: "peer_http" }));
  expect(r.sent.map((s) => s.to.channelId)).toEqual(["channel-b", "channel-b"]);
  for (const s of r.sent) expect(s.content).toBe(`[系统转交：这是回复前任 PM ${A} 的问题；当班 PM ${B}]\nanswer`);
});

test("other messages to an online former PM still go to the active PM", async () => {
  const r = await routing(true);
  await r.deliver(toA("agent_1_x", {}, r.clients.get("channel-a")!.ws, "request"));
  expect(r.sent[0]?.to.channelId).toBe("channel-b");
  expect(r.sent[0]?.content).toContain(`原收件人 ${A}`);
});

test("pointer moving between pmClientFor and deliverPmLocal re-resolves and never uses the lent socket", async () => {
  const r = await routing(true), lent = pmClientFor(A, r.clients, "scheduler", r.facts)!;
  expect(lent as unknown).toBe(r.clients.get("channel-b"));
  r.point(C);
  await r.deliver(toA("agent_1_x", {}, lent.ws, "request"));
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]!.to.ws).toBe(r.clients.get("channel-c")!.ws);
  expect(r.sent[0]!.content).toContain(`原收件人 ${A}；当班 PM ${C}`);
});

test("pointer moving back to the addressed PM uses its own socket, or drops when it is offline", async () => {
  const online = await routing(true), lent = pmClientFor(A, online.clients, "scheduler", online.facts)!;
  online.point(A);
  await online.deliver(toA("agent_1_x", {}, lent.ws, "request"));
  expect(online.sent.map((s) => s.to.ws)).toEqual([online.clients.get("channel-a")!.ws]);
  const offline = await routing(false), borrowed = pmClientFor(A, offline.clients, "scheduler", offline.facts)!;
  offline.point(A);
  const result = await offline.deliver(toA("agent_1_x", {}, borrowed.ws, "request"));
  expect(result.outcome.kind).toBe("dropped");
  expect(offline.sent).toEqual([]);
});

// Real transport entry: a resumed HTTP peer call whose caller (former PM A) has no socket.
async function resumedPeerReply(onlineA: boolean) {
  const r = await routing(onlineA), dir = mkdtempSync(join(tmpdir(), "pm-hp-")), path = join(dir, "calls.json");
  writeFileSync(path, JSON.stringify({ hp_1: { callerChannelId: "channel-a", callerName: A, peerName: "remote", peerAgent: "remote-pm", threadId: "th1", deadline: Date.now() + 5_000 } }));
  const held: Envelope[] = [];
  // Same expression bridge.ts passes as getClientWs.
  const getClientWs = (channelId: string) => ((r.clients.get(channelId) ?? pmClientFor(channelId, r.clients, undefined, r.facts))?.ws as any) ?? null;
  initHttpPeer({
    deliver: r.deliver, getClientWs, hold: (env) => held.push(env), callBookPath: path, pollIntervalMs: 10, pollGiveUpMs: 5_000,
    findPeer: async (n) => (n === "remote" ? { name: "remote", baseUrl: "http://x", outToken: "k".repeat(32), addedAt: "" } : null),
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, reply: "answer", threadId: "th1" }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
  });
  for (let i = 0; i < 50 && !r.sent.length && !held.length; i++) await Bun.sleep(10);
  rmSync(dir, { recursive: true, force: true });
  return { ...r, held };
}

test("resumed HTTP peer reply to an offline former PM reaches the active PM through the transport", async () => {
  const r = await resumedPeerReply(false);
  expect(r.held).toEqual([]);
  expect(r.sent.map((s) => [s.to.channelId, s.content])).toEqual([["channel-b", `[系统转交：这是回复前任 PM ${A} 的问题；当班 PM ${B}]\nanswer`]]);
});

test("resumed HTTP peer reply to an online former PM stays with it", async () => {
  const r = await resumedPeerReply(true);
  expect(r.sent.map((s) => [s.to.channelId, s.content])).toEqual([["channel-a", "answer"]]);
});

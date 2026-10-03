import { afterEach, expect, test } from "bun:test";
import { activeProjectPm, pmCandidates, pmRedirect } from "../src/lib/pm-role.js";
import { projectPm } from "../src/lib/scheduler-autostart.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { deliverPmLocal, pmClientFor } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import type { Envelope, LocalEndpoint, Delivery } from "../src/bridge/router.js";
import { A, B, D, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const fixture = () => { const f = pmFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const socket = () => ({ send: () => {} }) as unknown as LocalEndpoint["ws"];
const endpoint = (name = A, channelId = "channel-a"): LocalEndpoint => ({ kind: "local", agentName: name, channelId, ws: socket() });
function envelope(from: Envelope["from"], target = endpoint()): Envelope {
  return { from, to: target, content: "question", intent: "request", meta: { messageId: "message-1", threadId: "thread-1",
    triggerKind: "agent_tool", ts: "2026-01-01T00:00:00Z", replyTo: "native-reply", inReplyTo: "previous" } };
}
async function routing(f: ReturnType<typeof pmFixture>, active = true) {
  if (active) await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const state = await f.deps.read(), ws = socket(), book = new AgentCallBook(null);
  const clients = new Map([["channel-b", { ws }]]), sent: Envelope[] = [];
  const receipts = new Map<string, { tokenId: string; agentChannelId: string; agentName: string; messageId: string; resolve?: () => void }[]>();
  const facts = { db: f.db, agents: state.agents, principals: async () => ({ principals: state.principals }) };
  const send = async (env: Envelope, to: LocalEndpoint): Promise<Delivery> => { sent.push({ ...env, to }); return { envelope: env, outcome: { kind: "sent" } }; };
  return { state, facts, book, clients, sent, receipts, send, deliver: (env: Envelope) =>
    deliverPmLocal(env, env.to as LocalEndpoint, clients, book, receipts, send, facts) };
}

test("no activePm preserves projectPm, routing envelope and first non-dispatcher", async () => {
  const f = fixture(), r = await routing(f, false);
  expect(projectPm(f.db, P)).toBe(A);
  expect(activeProjectPm(f.db, P)).toBe(A);
  const env = envelope(endpoint("scheduler", "sender")), copy = { ...env };
  await r.deliver(env);
  expect(env).toEqual(copy);
  expect(r.sent[0]?.to).toBe(env.to);
});

for (const source of ["scheduler", "lend", "peer", "executor"]) test(`${source} reaches active PM with original-recipient header and intact reply metadata`, async () => {
  const f = fixture(), r = await routing(f);
  const from: Envelope["from"] = source === "peer" ? { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" }
    : endpoint(source === "executor" ? "agent-task-1" : source, "sender");
  const env = envelope(from), meta = { ...env.meta };
  await r.deliver(env);
  expect(env.to).toMatchObject({ agentName: B, channelId: "channel-b" });
  expect(env.content).toContain(`原收件人 ${A}`);
  expect(env.content.endsWith("question")).toBe(true);
  expect(env.meta).toEqual(meta);
  expect(projectPm(f.db, P)).toBe(B);
});

test("retired PM outbound messages and dispatcher inbound messages keep original recipients", async () => {
  const f = fixture(), r = await routing(f);
  expect(pmRedirect(f.db, P, A, A)).toBeNull();
  for (const env of [envelope(endpoint(A, "channel-a")), envelope(endpoint("scheduler", "sender"), endpoint(D, "channel-d"))]) {
    const original = env.to;
    await r.deliver(env);
    expect(env.to).toBe(original);
    expect(env.content).toBe("question");
  }
});

test("peer token contains A but not B: reject, notify B, never deliver original content", async () => {
  const f = fixture(), r = await routing(f);
  r.state.principals[0]!.agents = [A];
  const env = envelope({ kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" });
  const result = await r.deliver(env);
  expect(result.outcome).toMatchObject({ kind: "dropped", reason: `peer token scope excludes active PM ${B}` });
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]).toMatchObject({ to: { agentName: B }, intent: "notification", from: { kind: "bridge" } });
  expect(r.sent[0]!.content).not.toContain("question");
  expect(r.sent[0]!.content).not.toContain("DO-NOT-RETURN");
});

test("a revoked or mismatched peer principal cannot use an old envelope to gain final PM access", async () => {
  const f = fixture(), r = await routing(f);
  r.state.principals[0]!.disabled = true;
  expect((await r.deliver(envelope({ kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" }))).outcome.kind).toBe("dropped");
  r.state.principals[0]!.disabled = false;
  expect((await r.deliver(envelope({ kind: "api", tokenId: "tok_peer", peer: "wrong-peer", name: "remote" }))).outcome.kind).toBe("dropped");
});

test("retired PM can be offline while recipient resolution finds current PM socket", async () => {
  const f = fixture(), r = await routing(f);
  expect(r.clients.has("channel-a")).toBe(false);
  expect(pmClientFor(A, r.clients, "scheduler", r.facts)).toBe(r.clients.get("channel-b"));
  expect(pmClientFor(A, r.clients, A, r.facts)).toBeUndefined();
  const discordClient = { ws: socket(), channelId: "channel-b" };
  const fallback = pmClientFor("channel-a", new Map([["channel-b", discordClient]]), undefined, r.facts);
  expect(fallback).toMatchObject({ ws: discordClient.ws, channelId: "channel-a" });
  await r.deliver(envelope(endpoint("scheduler", "sender")));
  expect(r.sent[0]?.to).toMatchObject({ agentName: B });
});

test("move only redirected request's agent receipt; other requests remain with former PM", async () => {
  const f = fixture(), r = await routing(f), caller = endpoint("agent-task-1", "sender"), env = envelope(caller);
  const call = { callerName: "agent-task-1", callerChannelId: "sender", targetName: A, ts: 1, originalReplyChannel: "caller-reply" };
  r.book.add("channel-a", call, "earlier");
  r.book.add("channel-a", { ...call, expecting: "next step" }, env.meta.messageId);
  await r.deliver(env);
  expect(r.book.slot("channel-a", "sender")?.messageIds).toEqual(["earlier"]);
  const receipt = r.book.answerable("channel-b", () => false);
  expect(receipt).toMatchObject({ targetName: B, expecting: "next step", originalReplyChannel: "caller-reply", messageIds: ["message-1"] });
});

test("API synchronous waiter and thread stay attached to redirected request", async () => {
  const f = fixture(), r = await routing(f), env = envelope({ kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" });
  const resolve = () => {}, receipt = { tokenId: "tok_peer", agentChannelId: "channel-a", agentName: A, messageId: "message-1", resolve };
  r.receipts.set("tok_peer|channel-a", [receipt]);
  await r.deliver(env);
  expect(r.receipts.has("tok_peer|channel-a")).toBe(false);
  expect(r.receipts.get("tok_peer|channel-b")?.[0]).toBe(receipt);
  expect(receipt).toMatchObject({ resolve, agentName: B, agentChannelId: "channel-b" });
  expect(env.meta.threadId).toBe("thread-1");
});

test("candidate list excludes executor forms and dispatcher while preserving runtime and online facts", async () => {
  const f = fixture(), r = await routing(f, false);
  expect(pmCandidates(f.db, P, r.state.agents, f.online)).toEqual([
    { name: A, runtime: "claude-code", online: true, registered: true },
    { name: B, runtime: "codex", online: true, registered: true },
  ]);
});

test("ordinary API tokens also cannot redirect beyond their final recipient scope", async () => {
  const f = fixture(), r = await routing(f);
  r.state.principals.push({ id: "token:tok_guest", role: "external", agents: [A], createdAt: "2026-01-01" });
  const result = await r.deliver(envelope({ kind: "api", tokenId: "tok_guest", name: "guest" }));
  expect(result.outcome.kind).toBe("dropped");
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]!.content).not.toContain("question");
});

test("owner device scope is recomputed from its exact credential instead of the owner's broad principal", async () => {
  const f = fixture(), r = await routing(f);
  r.state.principals.push({ id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01", credentials: [{
    id: "dev-limited", expiresAt: "2050-01-01T00:00:00Z", grant: { agents: [A], terminal: false, manage: false },
  }] } as any);
  // Direct chat stays with A, so the device grant is checked against A: [A] passes, a grant without A is refused with no recipient.
  r.clients.set("channel-a", { ws: socket() });
  const ok = envelope({ kind: "api", tokenId: "owner:self", name: "owner", owner: true, credential: "dev-limited" } as any);
  expect((await r.deliver(ok)).outcome.kind).toBe("sent");
  expect(r.sent.map((e) => (e.to as LocalEndpoint).channelId)).toEqual(["channel-a"]);
  // The same grant [A] chatting directly with the active PM B is refused: no redirect involved, still the exact credential decides.
  const toB = envelope({ kind: "api", tokenId: "owner:self", name: "owner", owner: true, credential: "dev-limited" } as any, endpoint(B, "channel-b"));
  expect((await r.deliver(toB)).outcome).toMatchObject({ kind: "dropped", reason: `API credential scope excludes ${B}` });
  // Revoked, expired, a grant without A, or a disabled principal: A refuses too, never falling back to the owner's broad "*".
  const intact = JSON.stringify(r.state.principals.at(-1));
  const breaks: ((p: any) => void)[] = [(p) => { p.credentials[0].disabled = true; }, (p) => { p.credentials[0].expiresAt = "2020-01-01T00:00:00Z"; },
    (p) => { p.credentials[0].grant.agents = [B]; }, (p) => { p.disabled = true; }];
  for (const breakIt of breaks) {
    const p = JSON.parse(intact);
    breakIt(p);
    r.state.principals.splice(-1, 1, p);
    const result = await r.deliver(envelope({ kind: "api", tokenId: "owner:self", name: "owner", owner: true, credential: "dev-limited" } as any));
    expect(result.outcome).toMatchObject({ kind: "dropped", reason: `API credential scope excludes ${A}` });
  }
  expect(r.sent).toHaveLength(1);
});

test("owner direct chat with a retired PM stays with it: no header, no receipt move, active PM gets nothing", async () => {
  const f = fixture(), r = await routing(f);
  r.clients.set("channel-a", { ws: socket() });
  const env = envelope({ kind: "user", userId: "owner", channelId: "channel-a" } as Envelope["from"]), original = env.to;
  await r.deliver(env);
  expect(env.to).toBe(original);
  expect(env.content).toBe("question");
  expect(r.sent.map((e) => (e.to as LocalEndpoint).channelId)).toEqual(["channel-a"]);
});

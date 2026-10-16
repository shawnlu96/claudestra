/** Messages ingress drives the real held queue / flush rules; the runtime transport is an in-memory boundary. */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { handleApiMessages, type PendingApiRequest } from "../src/bridge/api-messages.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { isHumanRequest, type Envelope, type Delivery, type LocalEndpoint } from "../src/bridge/router.js";
import { stopSnapshot, takeApiWaiters } from "../src/bridge/stop-settle.js";
import { holdsUntilIdle } from "../src/lib/turn-state.js";
import { setSteerQueueWhenBusy } from "../src/lib/config-store.js";
import type { Principal } from "../src/lib/principals.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const owner: Principal = { id: "owner:self", name: "owner", role: "owner", agents: ["*"], createdAt: "t" };
const agent = { name: "agent-calm", channelId: "calm" };
const ws = {} as never;

function harness() {
  clearOpenedBy();
  const held = new HeldQueue(null), pending = new Map<string, PendingApiRequest[]>();
  const sent: Envelope[] = [], received: Envelope[] = [];
  let working = true, typing = 0, interrupts = 0, reBusy = false;
  const transport = async (env: Envelope): Promise<Delivery> => {
    received.push(env);
    if (reBusy) { working = true; reBusy = false; }
    if (isHumanRequest(env) && working) interrupts++;
    if (holdsUntilIdle(env.from.kind, env.meta.waitForIdle, { main: working ? "busy" : "idle", bg: false })) {
      held.holdEnv(env);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    sent.push(env);
    return { envelope: env, outcome: { kind: "sent" } };
  };
  const deps = {
    clients: new Map([[agent.channelId, { ws }]]), findApiAgent: async () => ({ ...agent, status: "active" }),
    deliver: transport, mirrorApiExchange: async () => {}, startTypingWithSafety: () => { typing++; }, lastMessageSource: new Map<string, string>(),
    pendingApiRequests: pending, apiReqKey: (token: string, cid: string) => `${token}|${cid}`,
    slash: { sendLine: async () => {}, mirror: async () => {}, scheduleClearRotation: () => {}, markThinking: () => {}, record: () => {},
      runManager: async () => ({ ok: true }) },
  };
  const flush: FlushDeps = {
    held, compacting: () => false, working: async () => working, isHumanRequest, client: () => ({ ws }),
    deliver: transport, touch: () => {}, agentBatch: () => false,
  };
  const send = (body: Record<string, unknown> | FormData, principal = owner) => {
    const multipart = body instanceof FormData;
    const req = new Request(`http://fixture/agents/${agent.name}/messages`, { method: "POST",
      ...(multipart ? { body } : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    return handleApiMessages(req, new URL(req.url), principal, "self", ["", agent.name] as RegExpMatchArray, deps);
  };
  return { held, pending, sent, received, send, flush, idle: () => { working = false; }, reBusy: () => { reBusy = true; },
    counts: () => ({ typing, interrupts }) };
}

function multipart(waitForIdle: string | undefined, files = false): FormData {
  const f = new FormData(); f.set("text", "keep going"); f.set("wait", "0");
  if (waitForIdle !== undefined) f.set("waitForIdle", waitForIdle);
  if (files) f.set("files", new File(["attachment survives"], "calm.txt"));
  return f;
}

test("[验收线 1] JSON and multipart queue without typing or interrupt, then flush once with original text/files", async () => {
  await setSteerQueueWhenBusy(true);
  for (const body of [{ text: "keep going", waitForIdle: true }, multipart("true", true)]) {
    const h = harness();
    const r = await h.send(body);
    expect(r.status).toBe(202);
    const result = await r.json() as { threadId: string };
    expect(result).toMatchObject({ queued: true, accepted: true, agent: agent.name });
    expect(h.counts()).toEqual({ typing: 0, interrupts: 0 });
    expect(h.sent).toEqual([]);
    const original = h.held.get(agent.channelId)![0].env;
    expect(original.meta.threadId).toBe(result.threadId);
    if (body instanceof FormData) expect(readFileSync(original.meta.attachments![0], "utf8")).toBe("attachment survives");
    h.idle();
    await Promise.all([flushHeld(h.flush, agent.channelId, "stop"), flushHeld(h.flush, agent.channelId, "compact_end"), flushHeld(h.flush, agent.channelId, "sweep")]);
    expect(h.sent).toEqual([original]);
    expect(h.held.ids(agent.channelId).size).toBe(0);
  }
});

test("[验收线 2] missing/false preserve preemption, invalid JSON/multipart booleans are 400", async () => {
  await setSteerQueueWhenBusy(true);
  for (const body of [{ text: "legacy" }, { text: "legacy", waitForIdle: false }, multipart(undefined), multipart("false")]) {
    const h = harness();
    expect((await h.send(body)).status).toBe(202);
    expect(h.counts()).toEqual({ typing: 1, interrupts: 1 });
    expect(h.sent).toHaveLength(1);
  }
  for (const value of [null, 1, "true", [], {}]) {
    const h = harness();
    expect((await h.send({ text: "invalid", waitForIdle: value })).status).toBe(400);
    expect(h.received).toHaveLength(0);
  }
  for (const value of ["", "1", "TRUE", "null"]) expect((await harness().send(multipart(value))).status).toBe(400);
});

test("[验收线 3] disabling only changes new requests; queued envelopes keep their no-preemption promise", async () => {
  await setSteerQueueWhenBusy(true);
  const h = harness();
  expect(await (await h.send({ text: "first", waitForIdle: true })).json()).toMatchObject({ queued: true });
  await setSteerQueueWhenBusy(false);
  expect(await (await h.send({ text: "second", waitForIdle: true })).json()).not.toHaveProperty("queued");
  expect(h.counts().interrupts).toBe(1);
  await flushHeld(h.flush, agent.channelId, "sweep");
  expect(h.sent.map(e => e.content)).toEqual(["second"]);
  expect(h.held.get(agent.channelId)![0].env.meta.waitForIdle).toBe(true);
  await setSteerQueueWhenBusy(true);
  expect(await (await h.send({ text: "third", waitForIdle: true })).json()).toMatchObject({ queued: true });
});

test("[验收线 4] queued wait returns 202 immediately; previous Stop cannot settle it; re-busy leaves the same thread queued", async () => {
  await setSteerQueueWhenBusy(true);
  const h = harness(), t0 = Date.now();
  const result = await (await h.send({ text: "later", wait: 1, waitForIdle: true })).json() as { threadId: string };
  expect(result).toMatchObject({ queued: true });
  expect(Date.now() - t0).toBeLessThan(800);
  const snap = stopSnapshot(h.held.ids(agent.channelId), h.pending);
  const stop = { cid: agent.channelId, stopChannelId: agent.channelId, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text: "previous answer" } };
  expect(takeApiWaiters(h.pending, stop, true, new Set(), snap.held, snap.waiters)).toEqual([]);
  h.idle(); h.reBusy();
  await flushHeld(h.flush, agent.channelId, "stop");
  expect(h.held.get(agent.channelId)).toHaveLength(1);
  expect(h.sent).toEqual([]);
  h.idle();
  await flushHeld(h.flush, agent.channelId, "sweep");
  expect(h.sent[0].meta.threadId).toBe(result.threadId);
  const settled = takeApiWaiters(h.pending, { ...stop, drain: { text: "answer for later" } }, true);
  expect(settled[0].result).toMatchObject({ threadId: result.threadId, reply: "answer for later" });
});

test("[验收线 2] idle wait still waits for its original reply and preserves timeout/pending semantics", async () => {
  await setSteerQueueWhenBusy(true);
  const h = harness(); h.idle();
  const response = h.send({ text: "sync", wait: 1, waitForIdle: true });
  let entry: PendingApiRequest | undefined;
  for (let i = 0; i < 100; i++) {
    entry = [...h.pending.values()].flat()[0];
    if (entry?.resolve) break;
    await Bun.sleep(1);
  }
  expect(entry?.resolve).toBeDefined();
  entry!.resolve!({ reply: "yes", threadId: entry!.threadId, agent: agent.name });
  expect(await (await response).json()).toMatchObject({ reply: "yes", threadId: entry!.threadId });
  const timed = await h.send({ text: "timeout", wait: 0.001 });
  expect(await timed.json()).toMatchObject({ timedOut: true });
  expect([...h.pending.values()].flat().at(-1)!.resolve).toBeUndefined();
});

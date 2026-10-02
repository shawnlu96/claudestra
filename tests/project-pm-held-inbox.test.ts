import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { subscribeEvents } from "../src/bridge/event-bus.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, INBOX_LEASE_MS, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

const CA = "channel-a", CB = "channel-b", OTHER = "channel-other";
const BODY = "[系统转交：原收件人 agent-alpha；当班 PM agent-beta]\n  我还有问题想问 A\n\n原文  ";
const cleanups: (() => void)[] = [];
beforeEach(clearOpenedBy);
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const ws = (id: string) => ({ id, send: () => {} }) as unknown as LocalEndpoint["ws"];
const target = (channelId: string): LocalEndpoint => ({ kind: "local", channelId, agentName: channelId === CA ? A : B, ws: ws(channelId) });

async function inboxWorld() {
  const fixture = pmFixture();
  cleanups.push(fixture.close);
  await switchProjectPm(fixture.db, P, B, { actor: "owner" }, fixture.deps);
  const state = await fixture.deps.read();
  state.principals.push({ id: "token:tok_owner", role: "owner", agents: ["*"], createdAt: "2026-01-01" } as never);
  const dir = mkdtempSync(join(tmpdir(), "pm-held-inbox-")), path = join(dir, "held.json");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let held = new HeldQueue(path);
  const clients = new Map([CA, CB].map((c) => [c, { ws: ws(c) }]));
  const calls = new AgentCallBook(null), busy = new Set<string>();
  const sent: { channel: string; text: string }[] = [], rendered: { channel: string; text: string }[] = [];
  const mirrors: { channel: string; text: unknown }[] = [];
  cleanups.push(subscribeEvents({}, (e) => { if (e.type === "chat_message") mirrors.push({ channel: e.chatId, text: e.data.text }); }));
  const init = () => initInbox({
    held, clients, calls, stoppedAt: () => undefined,
    render: async (env) => { rendered.push({ channel: (env.to as LocalEndpoint).channelId, text: env.content }); return env.content; },
    emitIn: (channel, env) => mirrors.push({ channel, text: env.content }),
  });
  init();
  const take = async (channel: string, opts: Parameters<typeof takeInbox>[2] = {}, now = Date.now()) => {
    const r = await takeInbox(clients.get(channel)!.ws, now, opts);
    if ("error" in r) throw new Error(r.error);
    return r.result;
  };
  const flush = (channel: string) => {
    const d: FlushDeps = {
      held, compacting: () => false, working: async (c) => busy.has(c), isHumanRequest: () => false,
      client: (c) => clients.get(c), touch: (c, e) => calls.touchDelivered(c, e), settled: async () => true, now: () => 1000,
      deliver: (env, to, wanted) => deliverPmLocal(env, to, clients, calls, new Map(), async (e, t) => {
        if (wanted && !wanted()) return { envelope: e, outcome: { kind: "dropped", reason: "removed" } };
        sent.push({ channel: t.channelId, text: e.content });
        return { envelope: e, outcome: { kind: "sent" } };
      }, { db: fixture.db, agents: state.agents, principals: async () => ({ principals: state.principals }) }),
    };
    return flushHeld(d, channel, "inbox-test");
  };
  const restart = () => { held = new HeldQueue(path); init(); };
  const q = (c: string) => held.get(c) ?? [];
  return { get held() { return held; }, take, flush, restart, q, clients, calls, busy, sent, rendered, mirrors };
}

function ownerLetter(text = BODY): Envelope {
  return {
    from: { kind: "api", tokenId: "tok_owner", name: "owner", owner: true }, to: target(CB), intent: "request", content: text,
    meta: { messageId: "same-button", threadId: "owner-thread", ts: "2026-10-01T00:00:00Z", triggerKind: "system" },
  };
}
type World = Awaited<ReturnType<typeof inboxWorld>>;
function dual(w: World, env = ownerLetter(), leases = false): void {
  w.held.set(CA, [{ env, to: target(CA), heldAt: 100, ...(leases ? { lease: { batchId: "inbox_A", at: Date.now() } } : {}) }]);
  w.held.set(CB, [{ env, to: target(CB), heldAt: 200, ...(leases ? { lease: { batchId: "inbox_B", at: Date.now() } } : {}) }]);
  w.restart(); // 真落盘读回，两个信封不再共享对象
}

const entry = (w: World, mode: string) => mode === "flush" ? w.flush(CB).then(() => ({ n: 0, text: "" }))
  : w.take(CB, mode === "take" ? {} : { read: mode === "read-thread" ? "owner-thread" : "same-button" });

for (const mode of ["take", "read", "read-thread", "flush"]) {
  for (const concurrent of [false, true]) {
    for (const availability of ["idle", "busy", "offline"]) {
      test(`inbox-bypass: persisted owner dual B-first ${mode}/${concurrent ? "concurrent" : "sequential"}/${availability}`, async () => {
        const w = await inboxWorld();
        dual(w);
        const a = w.clients.get(CA)!;
        if (availability === "busy") w.busy.add(CA);
        if (availability === "offline") w.clients.delete(CA);
        const first = entry(w, mode);
        const r = concurrent ? (await Promise.all([first, w.flush(CA), w.flush(CB)]))[0] : await first;
        expect(r.n).toBe(0);
        expect(r.text).not.toContain("我还有问题");
        expect(w.q(CB)).toEqual([]);
        expect(w.rendered.filter((e) => e.channel === CB)).toEqual([]);
        expect(w.mirrors.filter((e) => e.channel === CB)).toEqual([]);
        expect(w.sent.filter((e) => e.channel === CB)).toEqual([]);
        if (!concurrent || availability !== "idle") expect(w.q(CA)[0]).toMatchObject({ heldAt: 100, to: { channelId: CA }, env: { to: { channelId: CA } } });
        w.restart();
        w.busy.clear();
        w.clients.set(CA, a);
        await Promise.all([w.flush(CA), w.flush(CB), w.flush(CA)]);
        await w.flush(CA);
        expect(w.sent).toEqual([{ channel: CA, text: BODY }]);
        expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
      });
    }
  }
}

for (const evidence of ["missing-address", "conflicting-address", "marked-orphan"]) {
  for (const leased of [false, true]) {
    test(`inbox-bypass: unresolved ${evidence}/${leased ? "leased" : "free"} cannot take/read/ack/tally`, async () => {
      const w = await inboxWorld();
      dual(w, ownerLetter(), leased);
      if (evidence === "missing-address") w.q(CA)[0]!.to.channelId = "";
      if (evidence === "conflicting-address") w.held.set(OTHER, [{ ...w.q(CA)[0]!, to: target(OTHER) }]);
      if (evidence === "marked-orphan") {
        Object.assign(w.q(CB)[0]!.env, { pmTransfer: { from: CA, to: CB, header: "", legacy: true } });
        w.held.remove(CA, w.q(CA)[0]!); // 原 ask 已删，不补造
      }
      w.held.persist();
      const counts = [CA, CB, OTHER].map((c) => w.q(c).length);
      for (let i = 0; i < 2; i++) {
        w.restart();
        expect((await w.take(CB)).n).toBe(0);
        expect((await w.take(CB, { read: "same-button" })).n).toBe(0);
        expect((await w.take(CB, { read: "owner-thread" })).n).toBe(0);
        expect((await w.take(CB, { ack: "inbox_B" })).n).toBe(0);
        expect(w.held.stat(CB)).toEqual({});
        await Promise.all([w.flush(CA), w.flush(CB)]);
        expect([CA, CB, OTHER].map((c) => w.q(c).length)).toEqual(counts);
      }
      expect(w.sent).toEqual([]);
      expect(w.rendered).toEqual([]);
      expect(w.mirrors).toEqual([]);
    });
  }
}

test("inbox-bypass: tally first restores owner A and does not prompt B to read it", async () => {
  const w = await inboxWorld();
  dual(w);
  expect(w.held.stat(CB)).toEqual({});
  expect(w.held.stat(CA)).toEqual({ owner: 1 });
  w.restart();
  expect((await w.take(CB)).n).toBe(0);
  await w.flush(CA);
  expect(w.sent).toEqual([{ channel: CA, text: BODY }]);
});

test("inbox-bypass: existing A lease survives restoration, B old ack cannot clear it, A ack only clears its batch", async () => {
  const w = await inboxWorld();
  dual(w, ownerLetter(), true);
  const lease = { ...w.q(CA)[0]!.lease! };
  expect((await w.take(CB, { ack: "inbox_B" })).n).toBe(0);
  expect(w.q(CA)[0]!.lease).toEqual(lease);
  await Promise.all([w.flush(CA), w.flush(CB)]);
  expect(w.sent).toEqual([]);
  const reread = await w.take(CA);
  expect(reread.n).toBe(1);
  expect(reread.text).toContain("inbox_A");
  expect(w.q(CA)[0]!.lease).toEqual(lease);
  expect(w.held.stat(CA)).toEqual({});
  expect((await w.take(CA, { ack: "inbox_A" })).n).toBe(0);
  await w.flush(CA);
  expect(w.q(CA)).toEqual([]);
  expect(w.sent).toEqual([]);
});

test("inbox-bypass: only B held a wrong lease; restored A remains deliverable and B cannot re-read pages", async () => {
  const w = await inboxWorld();
  dual(w, ownerLetter(), true);
  delete w.q(CA)[0]!.lease;
  w.held.persist(); w.restart();
  expect((await w.take(CB)).n).toBe(0);
  expect((await w.take(CB, { read: "same-button", page: 2 })).n).toBe(0);
  expect(w.q(CA)[0]!.lease).toBeUndefined();
  await w.flush(CA);
  expect(w.sent).toEqual([{ channel: CA, text: BODY }]);
});

test("inbox-bypass: expired restored A lease can be re-leased and acknowledged without flush duplication", async () => {
  const w = await inboxWorld();
  dual(w, ownerLetter(), true);
  const now = Date.now() + INBOX_LEASE_MS + 1;
  expect((await w.take(CB, {}, now)).n).toBe(0);
  const r = await w.take(CA, {}, now), lease = w.q(CA)[0]!.lease!;
  expect(r.n).toBe(1);
  expect(lease).toMatchObject({ at: now });
  expect(lease.batchId).not.toBe("inbox_A");
  await w.take(CA, { ack: lease.batchId }, now);
  await w.flush(CA);
  expect(w.sent).toEqual([]);
  expect(w.q(CA)).toEqual([]);
});

test("inbox-bypass: legitimate repeated button IDs stay separate; fresh owner and role deliveries still take/ack normally", async () => {
  const w = await inboxWorld();
  const owner1 = ownerLetter("click 1"), owner2 = ownerLetter("click 2");
  owner2.meta.ts = "2026-10-01T00:00:01Z";
  w.held.set(CA, [owner1, owner2].map((env) => ({ env, to: target(CA), heldAt: 100 })));
  const role: Envelope = { ...ownerLetter("role notice"), from: { kind: "local", channelId: "executor", agentName: "agent-task-1", ws: ws("exec") } };
  w.held.set(CB, [owner1, owner2, role].map((env) => ({ env, to: target(CB), heldAt: 200 })));
  w.restart();
  const b = await w.take(CB);
  expect(b.n).toBe(1);
  expect(b.text).toContain("role notice");
  expect(b.text).not.toContain("click");
  const a = await w.take(CA);
  expect(a.n).toBe(2);
  expect(a.text).toContain("click 1");
  expect(a.text).toContain("click 2");
  await w.take(CB, { ack: w.q(CB)[0]!.lease!.batchId });
  await w.take(CA, { ack: w.q(CA)[0]!.lease!.batchId });
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
  const fresh = ownerLetter("new direct B");
  w.held.holdEnv(fresh);
  expect(w.held.stat(CB)).toEqual({ owner: 1 });
  expect((await w.take(CB)).text).toContain("new direct B");
});

test("inbox-bypass: role dual B-first take preserves B lease; A flush never redelivers the role body", async () => {
  const w = await inboxWorld();
  const role: Envelope = { ...ownerLetter("role body"), from: { kind: "local", agentName: "agent-task-1", channelId: "executor", ws: ws("exec") } };
  dual(w, role, true);
  const lease = { ...w.q(CB)[0]!.lease! };
  expect((await w.take(CB)).n).toBe(1);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)[0]!.lease).toEqual(lease);
  await Promise.all([w.flush(CA), w.flush(CB)]);
  expect(w.sent).toEqual([]);
  await w.take(CB, { ack: lease.batchId });
  expect(w.q(CB)).toEqual([]);
});

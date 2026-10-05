import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { subscribeEvents } from "../src/bridge/event-bus.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, INBOX_LEASE_MS, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { deliverPmLocal, pmRoleRoute } from "../src/bridge/local-api/project-pm-delivery.js";
import { setPmRoleRoute } from "../src/bridge/pm-held-transfer.js";
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
  const prev = setPmRoleRoute(pmRoleRoute({ db: fixture.db, agents: state.agents }));
  cleanups.push(() => { setPmRoleRoute(prev); });
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
        if (busy.has(t.channelId)) {
          held.holdEnv(e);
          return { envelope: e, outcome: { kind: "sent", note: "queued" } };
        }
        sent.push({ channel: t.channelId, text: e.content });
        return { envelope: e, outcome: { kind: "sent" } };
      }, { db: fixture.db, agents: state.agents, principals: async () => ({ principals: state.principals }) }),
    };
    return flushHeld(d, channel, "inbox-test");
  };
  const restart = () => { held = new HeldQueue(path); init(); };
  const q = (c: string) => held.get(c) ?? [];
  const scope = (agents: string[]) => { Object.assign(state.principals.find((p) => p.id === "token:tok_peer")!, { agents }); };
  return { get held() { return held; }, take, flush, restart, q, scope, clients, calls, busy, sent, rendered, mirrors };
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

function strandedRole(w: World, source: "executor" | "peer" | "ledger" = "executor"): HeldItem {
  const env = ownerLetter("  stranded role body\n\nunchanged  ");
  env.intent = "notification";
  if (source === "executor") env.from = { kind: "local", agentName: "agent-task-1", channelId: "executor", ws: ws("exec") };
  if (source === "peer") env.from = { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" };
  if (source === "ledger") {
    env.from = { kind: "bridge", label: "ledger" };
    env.meta.messageId = "ledger-ask:ask_test123";
  }
  w.held.set(CA, [{ env, to: target(CA), heldAt: 100 }]);
  w.restart();
  return w.q(CA)[0]!;
}

for (const source of ["executor", "peer", "ledger"] as const) {
  for (const availability of ["idle", "busy", "offline"] as const) {
    for (const mode of ["take", "read", "read-thread"]) {
      test(`stranded-role-inbox: ${source}/${availability}/${mode} stays for flush, never old-PM consumption`, async () => {
        const w = await inboxWorld(), item = strandedRole(w, source), body = item.env.content;
        const b = w.clients.get(CB)!;
        if (availability === "busy") w.busy.add(CB);
        if (availability === "offline") w.clients.delete(CB);
        const opts = mode === "take" ? {} : { read: mode === "read" ? item.env.meta.messageId : item.env.meta.threadId };
        const r = await w.take(CA, opts);
        expect(r.n).toBe(0);
        expect(r.text).not.toContain("stranded role body");
        expect(w.held.stat(CA)).toEqual({});
        expect(w.q(CA)).toEqual([item]);
        expect(item.lease).toBeUndefined();
        expect(w.rendered).toEqual([]);
        expect(w.mirrors).toEqual([]);
        await w.flush(CA);
        expect(w.sent.filter((e) => e.channel === CA)).toEqual([]);
        if (availability === "busy") {
          expect(w.q(CA)).toEqual([]);
          expect(w.q(CB)).toHaveLength(1);
          await w.flush(CB);
          expect(w.sent).toEqual([]);
        }
        if (availability === "offline") {
          expect(w.q(CA)).toEqual([item]);
          expect(item.heldAt).toBe(100);
          expect(w.sent).toEqual([]);
          await w.flush(CA);
          expect(w.q(CA)).toEqual([item]);
        }
        w.busy.clear(); w.clients.set(CB, b); w.restart();
        await Promise.all([w.flush(CA), w.flush(CB)]);
        await w.flush(CA); await w.flush(CB);
        expect(w.sent).toEqual([{ channel: CB, text: body }]);
        expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
      });
    }
  }
}

test("stranded-role-inbox: stale A lease cannot re-read or ack the transferred role; expiry allows flush retry", async () => {
  const w = await inboxWorld(), item = strandedRole(w), body = item.env.content;
  item.lease = { batchId: "inbox_old_A", at: Date.now() };
  w.held.persist(); w.restart();
  const retained = w.q(CA)[0]!, lease = { ...retained.lease! };
  expect((await w.take(CA)).n).toBe(0);
  expect((await w.take(CA, { read: retained.env.meta.messageId })).n).toBe(0);
  expect((await w.take(CA, { ack: lease.batchId })).n).toBe(0);
  expect(retained.lease).toEqual(lease);
  expect(w.q(CA)).toEqual([retained]);
  await w.flush(CA);
  expect(w.sent).toEqual([]);
  retained.lease!.at -= INBOX_LEASE_MS + 1; // 模拟原租约到期，不改批次号或队龄
  await w.flush(CA); await w.flush(CB);
  expect(w.sent).toEqual([{ channel: CB, text: body }]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

test("stranded-role-inbox: two legitimate same-messageId role clicks remain distinct, unrelated owner entry still takes/acks", async () => {
  const w = await inboxWorld(), first = strandedRole(w);
  const second: HeldItem = { ...first, env: { ...first.env, content: "second click", meta: { ...first.env.meta, ts: "2026-10-01T00:00:01Z" } } };
  const direct = ownerLetter("direct owner A");
  direct.to = target(CA); direct.meta = { ...direct.meta, messageId: "other-owner" };
  w.held.set(CA, [first, second, { env: direct, to: direct.to as LocalEndpoint, heldAt: 150 }]);
  w.restart();
  expect(w.held.stat(CA)).toEqual({ owner: 1 });
  const r = await w.take(CA);
  expect(r.n).toBe(1);
  expect(r.text).toContain("direct owner A");
  expect(r.text).not.toContain("stranded role body");
  expect(r.text).not.toContain("second click");
  const batch = w.q(CA).find((i) => i.env.meta.messageId === "other-owner")!.lease!.batchId;
  await w.take(CA, { ack: batch });
  expect(w.q(CA)).toHaveLength(2);
  await w.flush(CA); await w.flush(CB);
  expect(w.sent).toEqual([{ channel: CB, text: first.env.content }, { channel: CB, text: "second click" }]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

// followup-reliability-PMSWR：切换前押进旧 PM A 队、信封仍指向 A 的角色消息（未转交过）；A 离线 / 忙 / 在线领收件箱
function preSwitchRole(w: World, text = "  pre-switch role body\n\nunchanged  ", patch: (env: Envelope) => void = () => {}): HeldItem {
  const env = ownerLetter(text);
  env.intent = "notification";
  env.to = target(CA);
  env.from = { kind: "local", agentName: "agent-task-1", channelId: "executor", ws: ws("exec") };
  patch(env);
  w.held.set(CA, [...w.q(CA), { env, to: target(CA), heldAt: 100 }]);
  w.restart(); // 旧数据从盘上读回
  return w.q(CA).at(-1)!;
}
const HEADER = `[系统转交：原收件人 ${A}；当班 PM ${B}]`;

for (const b of ["idle", "busy", "offline"] as const) {
  for (const evidence of ["pre-switch", "old-transfer"] as const) {
    test(`retired-offline-stranded: A offline, B ${b}, ${evidence} role letter follows the active PM`, async () => {
      const w = await inboxWorld();
      const item = evidence === "pre-switch" ? preSwitchRole(w) : strandedRole(w);
      const body = evidence === "pre-switch" ? `${HEADER}\n${item.env.content}` : item.env.content;
      const bClient = w.clients.get(CB)!;
      w.clients.delete(CA);
      if (b === "busy") w.busy.add(CB);
      if (b === "offline") w.clients.delete(CB);
      await w.flush(CA);
      if (b === "idle") {
        expect(w.sent).toEqual([{ channel: CB, text: body }]);
        expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
        return;
      }
      expect(w.sent).toEqual([]);
      if (b === "busy") {
        expect(w.q(CA)).toEqual([]);
        expect(w.q(CB)).toHaveLength(1);
      } else {
        expect(w.q(CA)).toHaveLength(1);
        expect(w.q(CA)[0]!.heldAt).toBe(100);
      }
      w.busy.clear(); w.clients.set(CB, bClient); w.restart();
      await Promise.all([w.flush(CA), w.flush(CB)]);
      await w.flush(CA); await w.flush(CB);
      expect(w.sent).toEqual([{ channel: CB, text: body }]);
      expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
    });
  }
}

test("retired-offline-stranded: owner direct chat and A's own request answer keep A as destination while A is offline", async () => {
  const w = await inboxWorld();
  const direct = ownerLetter("direct owner A");
  direct.to = target(CA);
  const answer = preSwitchRole(w, "answer to A's own question", (env) => {
    env.intent = "response";
    env.meta = { ...env.meta, messageId: "agent_reply_1", triggerKind: "agent_tool" };
  });
  w.held.set(CA, [...w.q(CA), { env: direct, to: target(CA), heldAt: 150 }]);
  w.restart();
  const a = w.clients.get(CA)!;
  w.clients.delete(CA);
  for (let i = 0; i < 2; i++) { await w.flush(CA); await w.flush(CB); w.restart(); }
  expect(w.sent).toEqual([]);
  expect(w.q(CA).map((i) => i.env.content)).toEqual([answer.env.content, "direct owner A"]);
  expect(w.q(CA).every((i) => (i.env.to as LocalEndpoint).channelId === CA)).toBe(true);
  expect(w.q(CB)).toEqual([]);
  w.clients.set(CA, a);
  await w.flush(CA); await w.flush(CA); // 不同发送人各开一轮
  expect(w.sent).toEqual([{ channel: CA, text: "answer to A's own question" }, { channel: CA, text: "direct owner A" }]);
});

test("retired-offline-stranded: two legitimate same-messageId role clicks are both handed over, none deduplicated", async () => {
  const w = await inboxWorld();
  preSwitchRole(w, "click 1");
  preSwitchRole(w, "click 2", (env) => { env.meta = { ...env.meta, ts: "2026-10-01T00:00:01Z" }; });
  w.clients.delete(CA);
  await w.flush(CA);
  expect(w.sent).toEqual([{ channel: CB, text: `${HEADER}\nclick 1` }, { channel: CB, text: `${HEADER}\nclick 2` }]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

test("retired-offline-stranded: API credential scope is re-checked against the final PM every attempt; refusal leaks no body", async () => {
  const w = await inboxWorld();
  const scoped = (env: Envelope) => { env.from = { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" }; };
  preSwitchRole(w, "secret for A only", scoped);
  w.clients.delete(CA);
  w.scope([A]);
  await w.flush(CA);
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]).toMatchObject({ channel: CB });
  expect(w.sent[0]!.text).toContain("被拒收");
  expect(w.sent[0]!.text).not.toContain("secret for A only");
  expect(w.q(CA)).toEqual([]);
  w.sent.length = 0;
  preSwitchRole(w, "allowed now", scoped);
  w.scope([A, B]);
  await w.flush(CA);
  expect(w.sent).toEqual([{ channel: CB, text: `${HEADER}\nallowed now` }]);
});

for (const a of ["idle", "busy"] as const) {
  for (const mode of ["take", "read", "read-thread"]) {
    test(`pre-switch-role-inbox: A ${a} cannot ${mode}/tally the pre-switch role letter; flush hands it to B`, async () => {
      const w = await inboxWorld(), item = preSwitchRole(w);
      if (a === "busy") w.busy.add(CA);
      const opts = mode === "take" ? {} : { read: mode === "read" ? item.env.meta.messageId : item.env.meta.threadId };
      const r = await w.take(CA, opts);
      expect(r.n).toBe(0);
      expect(r.text).not.toContain("pre-switch role body");
      expect(w.held.stat(CA)).toEqual({});
      expect(item.lease).toBeUndefined();
      expect(w.rendered).toEqual([]);
      await w.flush(CA);
      expect(w.sent).toEqual([{ channel: CB, text: `${HEADER}\n  pre-switch role body\n\nunchanged  ` }]);
      expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
    });
  }
}

test("pre-switch-role-inbox: A's pre-switch lease cannot ack after the switch; expiry hands it to B once", async () => {
  const w = await inboxWorld(), item = preSwitchRole(w);
  item.lease = { batchId: "inbox_pre_A", at: Date.now() };
  w.held.persist(); w.restart();
  expect((await w.take(CA, { ack: "inbox_pre_A" })).n).toBe(0);
  expect(w.q(CA)).toHaveLength(1);
  await w.flush(CA);
  expect(w.sent).toEqual([]);
  w.q(CA)[0]!.lease!.at -= INBOX_LEASE_MS + 1;
  await w.flush(CA); await w.flush(CA); await w.flush(CB);
  expect(w.sent).toEqual([{ channel: CB, text: `${HEADER}\n  pre-switch role body\n\nunchanged  ` }]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

test("pre-switch-role-inbox: A's own direct chat and request answer stay takeable by A next to a handed-over role letter", async () => {
  const w = await inboxWorld();
  preSwitchRole(w, "role for B");
  preSwitchRole(w, "answer to A", (env) => {
    env.intent = "response";
    env.meta = { ...env.meta, messageId: "agent_reply_2", triggerKind: "agent_tool" };
  });
  const direct = ownerLetter("direct owner A");
  direct.to = target(CA); direct.meta = { ...direct.meta, messageId: "other-owner" };
  w.held.set(CA, [...w.q(CA), { env: direct, to: target(CA), heldAt: 150 }]);
  w.restart();
  const r = await w.take(CA);
  expect(r.n).toBe(2);
  expect(r.text).toContain("answer to A");
  expect(r.text).toContain("direct owner A");
  expect(r.text).not.toContain("role for B");
});

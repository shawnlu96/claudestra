import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { HeldQueue, INBOX_LEASE_MS, onHeldSettled, type HeldIdleControl, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { heldIdleBatchText, parseInboxBatch, parseInboxPage } from "../src/lib/inbox-batch.js";
import type { HeldIdleScope } from "../src/lib/held-idle-batch.js";

const ws = { tag: "HB1-reader" } as never;
const to: LocalEndpoint = { kind: "local", channelId: "pm-a", agentName: "PM-A", ws };
const scope: HeldIdleScope = {
  channelId: to.channelId, agentName: to.agentName!, sessionId: "session-a", projectId: "project-a", ownerId: "owner-a", permissionSource: "internal-a",
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const off of cleanups.splice(0)) off(); });

function notice(id: string, kind: "bridge" | "local" = "bridge", heldAt = 1000): HeldItem {
  const env: Envelope = {
    from: kind === "bridge" ? { kind: "bridge", label: "ledger" } : { kind: "local", channelId: "worker-a", agentName: "worker-a", ws },
    to, intent: "notification", content: `original ${id}`,
    meta: { messageId: id, threadId: `thread-${id}`, ts: "2026-10-06T01:00:00Z", triggerKind: kind === "bridge" ? "bridge_synth" : "agent_tool",
      waitForIdle: true, expectSession: "session-a" },
  };
  return { env, to, heldAt };
}

function fixture(items: HeldItem[], mode: HeldIdleControl["mode"] = "on") {
  const delivered: Envelope[] = [], mirrored: Envelope[] = [], touched: Pick<Envelope, "from" | "meta">[] = [];
  const proofs = new Map(items.map((i) => [i, { ...scope }]));
  let gate: "ready" | "quota" | "compacting" | "sessionGone" | "stopped" = "ready";
  const control: HeldIdleControl = { mode, scope: (i) => proofs.get(i), canTake: () => gate === "ready", delivered: (_c, e) => delivered.push(e) };
  const held = new HeldQueue(null, control);
  for (const i of items) held.hold(i.to.channelId, i);
  const calls = new AgentCallBook(null);
  const touch = calls.touchDelivered.bind(calls);
  calls.touchDelivered = (c, e) => { touched.push(e); touch(c, e); };
  const clients = new Map([[to.channelId, { ws }]]);
  let render: (e: Envelope) => Promise<string> = async (e) => `${e.meta.interruptNote ?? ""}${e.content}`;
  initInbox({ held, clients, calls, render: (e) => render(e), emitIn: (_c, e) => mirrored.push(e), stoppedAt: () => undefined });
  return { held, delivered, mirrored, touched, proofs, control, clients, calls,
    gate: (g: typeof gate) => { gate = g; }, render: (r: typeof render) => { render = r; } };
}

async function take(now = 10_000, opts: Parameters<typeof takeInbox>[2] = {}) {
  const r = await takeInbox(ws, now, opts);
  if ("error" in r) throw new Error(r.error);
  return r.result;
}
const batchId = (text: string) => /inbox_[\w-]+/.exec(text)![0];
const ids = (text: string) => {
  const parsed = parseInboxBatch(text);
  if (!Array.isArray(parsed)) throw new Error(`Invalid batch: ${parsed}`);
  return parsed.map((p) => p.messageId);
};
function windowGate() {
  let resume!: () => void;
  const promise = new Promise<void>((r) => { resume = r; });
  return { promise, resume };
}

test("busy PM: two early inspections and an ordinary internal notification are all received by this check_inbox", async () => {
  const items = [notice("inspection-1", "bridge", 1000), notice("inspection-2", "bridge", 2000), notice("ordinary", "local", 3000)];
  const s = fixture(items);
  // A continually busy PM has no Stop; tool-result reads are the actual recovery path.
  const r = await take();
  expect(r.n).toBe(3);
  expect(ids(r.text)).toEqual(items.map((i) => i.env.meta.messageId));
  expect((parseInboxBatch(r.text) as { from: string }[]).map((i) => i.from)).toEqual(["bridge:ledger", "bridge:ledger", "worker-a"]);
  expect(s.touched).toEqual(items.map((i) => i.env));
  expect(items.every((i) => i.lease?.batchId === batchId(r.text))).toBe(true);
  expect(s.delivered).toEqual([]);
  const again = await take(11_000);
  expect(ids(again.text)).toEqual(ids(r.text));
  expect(batchId(again.text)).toBe(batchId(r.text));
  expect(s.touched).toHaveLength(3);
  await take(12_000, { ack: batchId(r.text) });
  expect(s.delivered).toEqual(items.map((i) => i.env));
  await take(13_000, { ack: batchId(r.text) });
  expect(s.delivered).toHaveLength(3);
});

test("the injected release window constructs one stable batch of all qualified original items", async () => {
  const items = [notice("inspection-1", "bridge", 1000), notice("inspection-2", "bridge", 2000), notice("ordinary", "local", 3000)];
  const s = fixture(items);
  const original = items.map((i) => JSON.stringify(i));
  const text = await s.held.withIdleBatch(to.channelId, async (batch, stillWanted) => {
    expect(stillWanted()).toBe(true);
    expect(batch.scope).toEqual(scope);
    expect(batch.items).toEqual(items);
    expect((await take()).n).toBe(0); // The same lock excludes inbox while the release adapter owns the batch.
    return heldIdleBatchText(batch.items.map((item) => ({ item, text: item.env.content })));
  });
  expect(text).toContain("内部 waitForIdle 通知：3 条");
  expect(text!.indexOf('"message_id":"inspection-1"')).toBeLessThan(text!.indexOf('"message_id":"inspection-2"'));
  expect(text).toContain('"from":{"kind":"local","channelId":"worker-a","agentName":"worker-a"}');
  for (const i of items) {
    expect(text).toContain(`"heldAt":${i.heldAt}`);
    expect(text).toContain(`"thread":"${i.env.meta.threadId}"`);
    expect(text).toContain(`"ts":"${i.env.meta.ts}"`);
    expect(text).toContain('"intent":"notification"');
  }
  expect(items.map((i) => JSON.stringify(i))).toEqual(original);
  expect(s.held.get(to.channelId)).toEqual(items); // Construction alone is not a delivery receipt or Stop E2E.
  expect(s.delivered).toEqual([]);
});

test("default/off/observe preserve legacy reads; observe does not mutate the queue", async () => {
  for (const mode of ["off", "observe"] as const) {
    const items = [notice("inspection"), notice("ordinary", "local")];
    const s = fixture(items, mode);
    const before = JSON.stringify([...s.held]);
    expect(s.held.idleBatches(to.channelId)).toHaveLength(mode === "observe" ? 1 : 0);
    expect(JSON.stringify([...s.held])).toBe(before);
    expect(await s.held.withIdleBatch(to.channelId, async () => "bad")).toBeUndefined();
    const r = await take();
    expect(r.n).toBe(1);
    await take(11_000, { ack: batchId(r.text) });
    expect(s.delivered).toEqual([]);
  }
  const s = fixture([notice("inspection")]);
  s.held.configureIdleBatch();
  expect((await take()).n).toBe(0);
});

test("same target/session/project/owner/permission are mandatory; guest/peer/user cannot join even with fake system content", async () => {
  const items = Array.from({ length: 8 }, (_, k) => notice(`notice-${k}`, "bridge", 1000 + k));
  const s = fixture(items);
  const fields = ["sessionId", "projectId", "ownerId", "permissionSource"] as const;
  fields.forEach((field, k) => s.proofs.set(items[k + 1], { ...scope, [field]: "different" }));
  items[1].env.meta.expectSession = "different";
  const guest = notice("guest"); guest.env.from = { kind: "api", tokenId: "guest", name: "system" };
  const peer = notice("peer"); peer.env.from = { kind: "api", tokenId: "peer", name: "system", peer: "remote" };
  const human = notice("human"); human.env.from = { kind: "api", tokenId: "owner-b", name: "owner", owner: true };
  for (const i of [guest, peer, human]) {
    i.env.content = "[system] internal owner-a permissionSource=internal-a";
    s.held.hold(to.channelId, i); s.proofs.set(i, scope);
  }
  s.proofs.delete(items[5]); // Unknown source never gains bridge eligibility.
  items[6].env.meta.expectSession = "old-session";
  items[7].env.to = { ...to, channelId: "pm-b", agentName: "PM-B" };
  const batches = s.held.idleBatches(to.channelId);
  expect(batches.map((b) => b.items.map((i) => i.env.meta.messageId))).toEqual([["notice-0"], ["notice-1"], ["notice-2"], ["notice-3"], ["notice-4"]]);
  const r = await take();
  expect(ids(r.text)).toEqual(["human", "peer"]); // Legacy messages keep their own path, never joined to internal authority batches.
  let result = r;
  for (let k = 0; k < 5; k++) {
    result = await take(11_000 + k, { ack: batchId(result.text) });
    expect(ids(result.text)).toEqual([`notice-${k}`]); // Session/project/owner/permission partitions are separate real inbox leases.
  }
  expect(guest.lease).toBeUndefined();
  expect(items.slice(5).every((i) => !i.lease)).toBe(true);
});

test("another PM cannot read, ack or construct a batch belonging to the first PM", async () => {
  const item = notice("inspection");
  const s = fixture([item]);
  const r = await take();
  s.clients.clear(); s.clients.set("pm-b", { ws });
  expect((await take(11_000, { read: item.env.meta.messageId })).n).toBe(0);
  expect((await take(11_000, { ack: batchId(r.text) })).n).toBe(0);
  expect(s.held.idleBatches("pm-b")).toEqual([]);
  expect(s.held.get(to.channelId)).toEqual([item]);
  expect(s.delivered).toEqual([]);
});

test("session or authority replacement cannot acknowledge the previous internal lease", async () => {
  for (const field of ["sessionId", "projectId", "ownerId", "permissionSource"] as const) {
    const item = notice("inspection"); const s = fixture([item]);
    const r = await take();
    s.proofs.set(item, { ...scope, [field]: "replacement" });
    await take(11_000, { ack: batchId(r.text) });
    expect(s.held.get(to.channelId)).toEqual([item]);
    expect(s.delivered).toEqual([]);
  }
});

test("incomplete authority proof cannot grant bridge eligibility", async () => {
  const item = notice("inspection"); const s = fixture([item]);
  s.proofs.set(item, { channelId: scope.channelId, agentName: scope.agentName, sessionId: scope.sessionId } as HeldIdleScope);
  expect(s.held.idleBatches(to.channelId)).toEqual([]);
  expect((await take()).n).toBe(0);
});

test("queue recovery preserves the internal lease authority and each acknowledged delivery callback", async () => {
  const item = notice("inspection"); const s = fixture([item]);
  const r = await take();
  const dir = mkdtempSync(join(tmpdir(), "hb1-held-recovery-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "held.json");
  const disk = new HeldQueue(path, s.control); disk.hold(to.channelId, item);
  const recovered = new HeldQueue(path, { ...s.control, scope: () => scope });
  expect(recovered.get(to.channelId)![0].lease).toEqual(item.lease);
  initInbox({ held: recovered, clients: s.clients, calls: s.calls, stoppedAt: () => undefined, render: async (e) => e.content, emitIn: () => {} });
  await take(11_000, { ack: batchId(r.text) });
  await take(12_000, { ack: batchId(r.text) });
  expect(s.delivered.map((e) => e.meta.messageId)).toEqual(["inspection"]);
  expect(new HeldQueue(path).get(to.channelId)).toBeUndefined();
});

test("quota/compacting/sessionGone/stopped gates retain originals and unknown sources use the old path", async () => {
  for (const gate of ["quota", "compacting", "sessionGone", "stopped"] as const) {
    const items = [notice("inspection"), notice("ordinary", "local")];
    const s = fixture(items);
    s.gate(gate);
    expect((await take()).n).toBe(0);
    expect((await take(10_000, { read: "inspection" })).n).toBe(0);
    expect(s.held.idleBatches(to.channelId)).toEqual([]);
    expect(items.every((i) => !i.lease && i.heldAt === 1000)).toBe(true);
    expect(s.delivered).toEqual([]);
    s.gate("ready");
    expect((await take()).n).toBe(2);
  }
  const ordinary = notice("unproven", "local");
  const s = fixture([ordinary]); s.proofs.clear();
  expect(s.held.idleBatches(to.channelId)).toEqual([]);
  expect((await take()).n).toBe(1);
});

test("Stop lock and check_inbox lease have exactly one holder; expired lease can be reclaimed without acknowledgement", async () => {
  const item = notice("inspection");
  const s = fixture([item]);
  expect(s.held.claim(to.channelId)).toBe(true);
  expect((await take()).n).toBe(0);
  s.held.release(to.channelId);
  const r = await take();
  expect(s.held.idleBatches(to.channelId, 10_000)).toEqual([]);
  expect(await s.held.withIdleBatch(to.channelId, async () => "bad", 10_000)).toBeUndefined();
  const relet = await take(10_000 + INBOX_LEASE_MS + 1);
  expect(batchId(relet.text)).not.toBe(batchId(r.text));
  await take(10_000 + INBOX_LEASE_MS + 2, { ack: batchId(r.text) });
  expect(s.delivered).toEqual([]);
  expect(s.held.get(to.channelId)).toEqual([item]);
});

test("real quota-wall items are ineligible until the existing wall release clears their reason", async () => {
  const item = notice("inspection"); const s = fixture([item]);
  expect(s.held.markWall(to.channelId, () => true)).toBe(1);
  expect((await take()).n).toBe(0);
  expect(s.held.idleBatches(to.channelId)).toEqual([]);
  expect(item.heldAt).toBe(1000);
  expect(s.held.releaseWall(5000)).toBe(1);
  expect((await take()).n).toBe(1);
});

test("a delivery callback exception does not acknowledge another message twice", async () => {
  const items = [notice("inspection-1"), notice("inspection-2")]; const s = fixture(items);
  const attempts: string[] = [];
  s.control.delivered = (_c, e) => { attempts.push(e.meta.messageId); if (e === items[0].env) throw new Error("injected callback failure"); };
  const r = await take();
  await take(11_000, { ack: batchId(r.text) });
  await take(12_000, { ack: batchId(r.text) });
  expect(attempts).toEqual(["inspection-1", "inspection-2"]);
  expect(s.held.get(to.channelId)).toBeUndefined();
});

test("human preemption/permission change during rendering is rechecked before acquisition and at the release window", async () => {
  const item = notice("inspection");
  const s = fixture([item]);
  s.render(async (env) => { s.gate("stopped"); return env.content; });
  expect((await take()).n).toBe(0);
  expect(item.lease).toBeUndefined();
  s.gate("ready");
  await s.held.withIdleBatch(to.channelId, async (_batch, wanted) => {
    expect(wanted()).toBe(true);
    s.proofs.set(item, { ...scope, permissionSource: "revoked" });
    expect(wanted()).toBe(false);
  });
  expect(s.delivered).toEqual([]);
});

test("normal human requests still lead the inbox and retain stop intent marking", async () => {
  const item = notice("inspection");
  const human = notice("human");
  human.env.from = { kind: "api", tokenId: "owner", name: "owner", owner: true };
  human.env.intent = "request"; delete human.env.meta.waitForIdle;
  const s = fixture([item, human]);
  initInbox({ held: s.held, clients: s.clients, calls: s.calls, stoppedAt: () => 2000,
    render: async (e) => `${e.meta.interruptNote ?? ""}${e.content}`, emitIn: () => {} });
  const r = await take();
  expect(ids(r.text)).toEqual(["human"]);
  expect(r.text).toContain("先别照做");
  expect(ids((await take(11_000, { ack: batchId(r.text) })).text)).toEqual(["inspection"]);
});

test("single render exception keeps that message, other messages can be read; failed paging has no lease or delivery receipt", async () => {
  const bad = notice("bad"), good = notice("good");
  const s = fixture([bad, good]);
  s.render(async (e) => { if (e === bad.env) throw new Error("injected render failure"); return e.content; });
  const r = await take();
  expect(ids(r.text)).toEqual(["good"]);
  expect(bad.lease).toBeUndefined();
  expect(await takeInbox(ws, 11_000, { read: "bad" })).toHaveProperty("error");
  expect(bad.lease).toBeUndefined();
  await take(12_000, { ack: batchId(r.text) });
  expect(s.delivered).toEqual([good.env]);
  expect(s.held.get(to.channelId)).toEqual([bad]);
});

test("lost tool result or mirror exception retains the original lease and gives no false delivery receipt", async () => {
  const item = notice("ordinary", "local");
  const s = fixture([item]);
  initInbox({ held: s.held, clients: s.clients, calls: s.calls, render: async (e) => e.content,
    stoppedAt: () => undefined, emitIn: () => { throw new Error("injected mirror failure"); } });
  expect(await takeInbox(ws, 10_000)).toHaveProperty("error");
  expect(item.lease).toBeDefined();
  expect(s.held.get(to.channelId)).toEqual([item]);
  expect(s.delivered).toEqual([]);
  initInbox({ held: s.held, clients: s.clients, calls: s.calls, render: async (e) => e.content,
    stoppedAt: () => undefined, emitIn: (_c, e) => s.mirrored.push(e) });
  const r = await take(11_000);
  expect(s.mirrored).toEqual([item.env]);
  expect(r.text).toContain("原样重给");
  expect(s.delivered).toEqual([]);
});

test("failed release construction retains messages and releases the channel lock", async () => {
  const item = notice("inspection");
  const s = fixture([item]);
  await expect(s.held.withIdleBatch(to.channelId, async () => { throw new Error("unknown send result"); })).rejects.toThrow("unknown send result");
  expect(s.held.get(to.channelId)).toEqual([item]);
  expect(s.delivered).toEqual([]);
  expect(s.held.claim(to.channelId)).toBe(true);
  s.held.release(to.channelId);
});

test("paging/large items preserve page limits, mirror once, touch once and invoke each original callback only after ack", async () => {
  const item = notice("large"); item.env.content = "x".repeat(30_000);
  const s = fixture([item]);
  const events: BridgeEvent[] = [];
  cleanups.push(subscribeEvents({}, (e) => { if (e.chatId === to.channelId && e.type === "chat_message") events.push(e); }));
  const settled: Envelope[] = [];
  cleanups.push(onHeldSettled((e, outcome) => { if (outcome === "delivered") settled.push(e); }));
  expect((await take()).text.length).toBeLessThan(16_000);
  expect(item.lease).toBeUndefined();
  const pages: string[] = [];
  for (let p = 1; p <= 3; p++) {
    const r = await take(11_000 + p, { read: "large", page: p });
    const parsed = parseInboxPage(r.text)!;
    expect(parsed.chunk.length).toBeLessThanOrEqual(12_000);
    pages.push(parsed.chunk);
  }
  expect(pages.join("")).toContain(item.env.content);
  expect(s.touched).toEqual([item.env]);
  expect(events).toHaveLength(1);
  expect(s.delivered).toEqual([]);
  await take(12_000, { ack: item.lease!.batchId });
  expect(s.delivered).toEqual([item.env]); expect(settled).toEqual([item.env]);
});

test("page-size limit leases ten then the remainder, without losing or duplicating original callbacks", async () => {
  const items = Array.from({ length: 12 }, (_, i) => notice(`inspection-${i}`));
  const s = fixture(items);
  const first = await take();
  expect(first.n).toBe(10); expect(first.text.length).toBeLessThan(16_000);
  const next = await take(11_000, { ack: batchId(first.text) });
  expect(next.n).toBe(2);
  await take(12_000, { ack: batchId(next.text) });
  expect(s.delivered).toEqual(items.map((i) => i.env));
  expect(s.held.get(to.channelId)).toBeUndefined();
});

test("a large preview does not starve a short message in a different permission partition", async () => {
  const long = notice("large"); long.env.content = "x".repeat(30_000);
  const short = notice("short"); const s = fixture([long, short]);
  s.proofs.set(short, { ...scope, permissionSource: "another-internal-source" });
  const r = await take();
  expect(r.n).toBe(1);
  expect(ids(r.text)).toEqual(["short", "large"]);
  expect(long.lease).toBeUndefined(); expect(short.lease).toBeDefined();
  expect(r.text.length).toBeLessThan(16_000);
});

test("reader replacement while paging keeps the original message unleased", async () => {
  const item = notice("inspection"); const s = fixture([item]);
  const window = windowGate();
  s.render(async (e) => { await window.promise; return e.content; });
  const pending = takeInbox(ws, 10_000, { read: "inspection" });
  s.clients.set(to.channelId, { ws: { tag: "replacement" } as never }); window.resume();
  expect(await pending).toHaveProperty("error");
  expect(item.lease).toBeUndefined(); expect(s.delivered).toEqual([]);
});

test("ledger ask and owner/card answer retain their shared first batch ahead of idle inspections", async () => {
  for (const mode of ["off", "on"] as const) {
    const ask = notice("ledger-ask:ask_abc"), inspection = notice("inspection");
    const human = notice("human"), answer = notice("answer");
    human.env.from = { kind: "api", tokenId: "owner", name: "owner", owner: true };
    human.env.intent = "request"; delete human.env.meta.waitForIdle;
    answer.env.from = human.env.from; answer.env.meta.triggerKind = "ask_answer";
    const s = fixture([ask, inspection, human, answer], mode);
    const r = await take();
    expect(ids(r.text)).toEqual(["ledger-ask:ask_abc", "human", "answer"]);
    expect(inspection.lease).toBeUndefined();
    const next = await take(11_000, { ack: batchId(r.text) });
    expect(next.n).toBe(mode === "on" ? 1 : 0);
    expect(s.held.get(to.channelId)).toEqual([inspection]);
  }
});

test("expired internal leases can be taken by a replacement session but cannot acknowledge the old scope", async () => {
  for (const kind of ["bridge", "local"] as const) {
    for (const field of ["sessionId", "projectId", "ownerId", "permissionSource"] as const) {
      const item = notice("inspection", kind); delete item.env.meta.expectSession;
      const s = fixture([item]);
      const first = await take();
      const replacement = { ...scope, [field]: "replacement" };
      s.proofs.set(item, replacement);
      expect((await take(11_000)).n).toBe(0);
      const expired = 10_000 + INBOX_LEASE_MS + 1;
      expect(s.held.idleBatches(to.channelId, expired).map((b) => b.items)).toEqual([[item]]);
      expect(s.held.inboxAckable(item)).toBe(false);
      const next = await take(expired, { ack: batchId(first.text) });
      expect(ids(next.text)).toEqual(["inspection"]);
      expect(item.lease!.idleScope).toEqual(replacement);
      expect(batchId(next.text)).not.toBe(batchId(first.text));
      expect(s.delivered).toEqual([]);
      await take(expired + 1, { ack: batchId(next.text) });
      expect(s.delivered).toEqual([item.env]);
    }
  }
});

test("removing idle control reports blocked confirmation without claiming an unread receipt", async () => {
  const item = notice("inspection"); const s = fixture([item]);
  const first = await take(); s.held.configureIdleBatch();
  const ack = await take(11_000, { ack: batchId(first.text) });
  expect(ack.text).toContain("权限无法核对");
  expect(ack.text).not.toContain("没有待确认的条目");
  expect(s.held.get(to.channelId)).toEqual([item]); expect(s.delivered).toEqual([]);
  s.held.configureIdleBatch(s.control);
  await take(12_000, { ack: batchId(first.text) });
  expect(s.delivered).toEqual([item.env]);
});

test("a partial mirror failure retries only missing mirrors on reread, direct ack, or queue recovery", async () => {
  for (const retry of ["reread", "ack", "recovery"] as const) {
    const items = [notice("first", "local"), notice("second", "local"), notice("third", "local")];
    const s = fixture(items); const mirrored: string[] = [];
    let fail = true;
    const init = (held: HeldQueue) => initInbox({ held, clients: s.clients, calls: s.calls, render: async (e) => e.content,
      stoppedAt: () => undefined, emitIn: (_c, e) => {
        if (fail && e === items[1].env) throw new Error("injected mid-batch mirror failure");
        mirrored.push(e.meta.messageId);
      } });
    const dir = mkdtempSync(join(tmpdir(), "hb1-mirror-recovery-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "held.json");
    const disk = new HeldQueue(path, s.control);
    items.forEach((i) => disk.hold(to.channelId, i));
    init(disk);
    expect(await takeInbox(ws, 10_000)).toHaveProperty("error");
    const lease = { ...items[0].lease! };
    expect(mirrored).toEqual(["first"]); expect(s.delivered).toEqual([]);
    expect(await takeInbox(ws, 10_001, { ack: lease.batchId })).toHaveProperty("error");
    expect(disk.get(to.channelId)).toEqual(items); expect(s.delivered).toEqual([]);
    if (retry === "recovery") init(new HeldQueue(path, { ...s.control, scope: () => scope }));
    fail = false;
    if (retry !== "ack") {
      const reread = await take(11_000);
      expect(batchId(reread.text)).toBe(lease.batchId);
    }
    await take(12_000, { ack: lease.batchId });
    expect(mirrored).toEqual(["first", "second", "third"]);
    expect(s.delivered.map((e) => e.meta.messageId)).toEqual(["first", "second", "third"]);
    expect(s.touched).toHaveLength(3);
  }
});

test("paging retries a missing mirror on the existing lease without touching or confirming twice", async () => {
  const item = notice("large", "local"); item.env.content = "x".repeat(30_000);
  const s = fixture([item]); let fail = true;
  initInbox({ held: s.held, clients: s.clients, calls: s.calls, render: async (e) => e.content,
    stoppedAt: () => undefined, emitIn: (_c, e) => {
      if (fail) throw new Error("injected page mirror failure"); s.mirrored.push(e);
    } });
  expect(await takeInbox(ws, 10_000, { read: "large" })).toHaveProperty("error");
  const lease = { ...item.lease! }; fail = false;
  expect((await take(11_000, { read: "large", page: 2 })).n).toBe(1);
  expect(s.mirrored).toEqual([item.env]); expect(s.touched).toEqual([item.env]);
  expect(item.lease!.batchId).toBe(lease.batchId); expect(item.lease!.at).toBe(lease.at);
  await take(12_000, { ack: lease.batchId }); expect(s.delivered).toEqual([item.env]);
});


test("expired session scopes can be reacquired by paged reads or the injected release window", async () => {
  for (const route of ["page", "release"] as const) {
    const item = notice("inspection"); delete item.env.meta.expectSession;
    const s = fixture([item]); const first = await take();
    const replacement = { ...scope, sessionId: "session-b" }; s.proofs.set(item, replacement);
    const expired = 10_000 + INBOX_LEASE_MS + 1;
    if (route === "page") {
      expect((await take(expired, { read: "inspection" })).n).toBe(1);
      expect(item.lease!.idleScope).toEqual(replacement);
      expect(item.lease!.batchId).not.toBe(batchId(first.text));
    } else {
      const result = await s.held.withIdleBatch(to.channelId, async (batch, wanted) => {
        expect(wanted()).toBe(true); expect(batch.scope).toEqual(replacement);
        expect(batch.items).toEqual([item]); return "constructed";
      }, expired);
      expect(result).toBe("constructed"); expect(item.lease!.batchId).toBe(batchId(first.text));
    }
    expect(s.delivered).toEqual([]);
  }
});

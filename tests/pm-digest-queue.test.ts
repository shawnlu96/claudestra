import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { PM_DIGEST_WINDOW_MS } from "../src/lib/pm-digest.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { heldCarriers, PmDigest } from "../src/bridge/pm-digest.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { createKeyedSerial } from "../src/lib/keyed-serial.js";
import { pmDigestStats } from "../src/manager/pm-digest-cmds.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";

const P = "proj", PM = "agent-pm", dirs: string[] = [];
const live: PmDigest[] = [];
afterEach(() => { for (const d of live.splice(0)) d.stop(); for (const d of dirs.splice(0)) { closeLedger(join(d, "ledger.sqlite")); rmSync(d, { recursive: true, force: true }); } });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const pmTo: LocalEndpoint = { kind: "local", agentName: PM, channelId: "ch-pm", ws };
const workerTo: LocalEndpoint = { kind: "local", agentName: "agent-w", channelId: "ch-w", ws };
let seq = 0;
const env = (from: Envelope["from"], content: string, oneShot = true, to = pmTo): Envelope => ({
  from, to, intent: "request", content,
  meta: { messageId: `m${++seq}`, threadId: `t${seq}`, ts: "2026-10-10T00:00:00Z", triggerKind: "agent_tool", ...(oneShot ? { skipInterAgentWatchdog: true } : {}) },
});
const sched = (card: string) => env({ kind: "local", agentName: "scheduler", channelId: "", ws }, `[上线后待办] ${card} 已上线，规格要求 PM 接着做：\n- x`);
const owner = (text = "owner 问进度") => env({ kind: "user", userId: "u", channelId: "ch-pm" }, text, false);
const sync = (text = "agents-A1 进度：写完了一半") => env({ kind: "local", agentName: "agent-w", channelId: "ch-w", ws }, text);

function world(mode?: "on" | "observe" | "off", dir = mkdtempSync(join(tmpdir(), "pm-digest-"))) {
  dirs.push(dir);
  const db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  const store = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  if (mode) store.setMode(P, mode);
  let clock = 1_000_000;
  const sent: { content: string; to: string; id: string }[] = [];
  let outcome: Delivery["outcome"] = { kind: "sent" };
  // 押后走真的押后队列（落盘）：bridge 的 deliverToLocal 押下时同样 holdEnv 这封信封本身
  const heldPath = join(dir, "held.json");
  let held = new HeldQueue(heldPath);
  const raw = async (e: Envelope, t: LocalEndpoint): Promise<Delivery> => {
    if (outcome.kind === "sent" && !outcome.note) sent.push({ content: e.content, to: t.agentName ?? "", id: e.meta.messageId });
    if (outcome.kind === "sent" && outcome.note === "queued") held.holdEnv(e);
    return { envelope: e, outcome };
  };
  const make = () => new PmDigest({ store, now: () => clock, db: () => db,
    agents: () => [{ name: PM, projectId: P, channelId: "ch-pm" } as never, { name: "agent-b", projectId: P, channelId: "ch-b" } as never],
    heldCarriers: () => heldCarriers(heldPath) });
  const clients = new Map([["ch-pm", { ws }], ["ch-b", { ws }]]);
  let digest = make();
  // bridge 的 deliver → deliverPmLocal → wrap：投本地不带押后条目的撤销条件
  const send = (e: Envelope, base = raw) => digest.wrap(base, db, P)(e, e.to as LocalEndpoint);
  const boot = () => { live.push(digest); digest.start({ clients, deliver: (e) => send(e) }, false); };
  boot();
  return { dir, db, store, sent, send, raw, clients, held: () => held,
    tick: () => digest.tick(), restart: () => { digest.stop(); held = new HeldQueue(heldPath); digest = make(); boot(); },
    advance: (ms: number) => { clock += ms; }, setOutcome: (o: Delivery["outcome"]) => { outcome = o; } };
}

test("on: mergeable is not delivered; the next immediate message carries the digest first, then the body, and empties the queue", async () => {
  const w = world("on");
  const r1 = await w.send(sched("T1")), r2 = await w.send(sync());
  expect(r1.outcome).toEqual({ kind: "sent", note: "digest" });
  expect(r2.outcome).toEqual({ kind: "sent", note: "digest" });
  expect(w.sent).toEqual([]);
  expect(w.store.queued(P)).toHaveLength(2);
  const o = owner();
  await w.send(o);
  expect(w.sent).toHaveLength(1);
  const c = w.sent[0]!.content;
  expect(c.startsWith("[📨 PM 摘要] 2 条")).toBe(true);
  expect(c.indexOf("T1")).toBeLessThan(c.indexOf("owner 问进度"));
  expect(c.endsWith("owner 问进度")).toBe(true);
  expect(w.store.queued(P)).toEqual([]);
  await w.send(owner("第二条"));
  expect(w.sent[1]!.content).toBe("第二条");
});

test("on: only mergeable → one standalone digest once the oldest has waited a full window", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.advance(PM_DIGEST_WINDOW_MS - 1000);
  await w.send(sync());
  await w.tick();
  expect(w.sent).toEqual([]);
  w.advance(1000);
  await w.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.content.split("\n")).toHaveLength(3);
  expect(w.store.queued(P)).toEqual([]);
  await w.tick();
  expect(w.sent).toHaveLength(1);
});

test("on: repeated reminders for the same card from the same source collapse to one line with a count", async () => {
  const w = world("on");
  for (let i = 0; i < 3; i++) await w.send(sched("T1"));
  await w.send(sched("T2"));
  await w.send(owner());
  const lines = w.sent[0]!.content.split("\n");
  expect(lines[0]).toContain("4 条");
  expect(lines[1]).toContain("scheduler · T1 · ");
  expect(lines[1]).toEndWith("（×3）");
  expect(lines[2]).toContain("scheduler · T2 · ");
});

test("on: a failed / offline immediate delivery keeps the queue and leaves the body untouched", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  for (const o of [{ kind: "error", error: new Error("x") }, { kind: "dropped", reason: "offline" }] as Delivery["outcome"][]) {
    w.setOutcome(o);
    const e = owner("正文");
    await w.send(e);
    expect(e.content).toBe("正文");
    expect(w.store.queued(P)).toHaveLength(1);
  }
  w.setOutcome({ kind: "sent" });
  await w.send(owner("正文"));
  expect(w.sent[0]!.content).toContain("T1");
  expect(w.store.queued(P)).toEqual([]);
});

test("digest goes after the PM transfer header and is never stacked on a replayed envelope", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  const e = owner("正文") as Envelope & { pmTransfer?: { header: string } };
  e.pmTransfer = { header: "[系统转交：原收件人 agent-old；当班 PM agent-pm]" };
  e.content = `${e.pmTransfer.header}\n正文`;
  w.setOutcome({ kind: "sent", note: "queued" });
  await w.send(e);
  await w.send(sched("T2"));
  w.setOutcome({ kind: "sent" });
  await w.send(e);
  const c = w.sent[0]!.content;
  expect(c.startsWith("[系统转交")).toBe(true);
  expect(c.split("[📨 PM 摘要]")).toHaveLength(2);
  expect(c).toContain("T1");
  expect(c).toContain("T2");
  expect(c.endsWith("\n\n正文")).toBe(true);
});

test("observe: delivery sequence identical to no digest at all, only records added; off: no records, no queue", async () => {
  const inputs = () => [sched("T1"), sync(), owner(), sched("T1"), env({ kind: "bridge", label: "ledger-audit" }, "[🔎 台账巡检] 新发现 1 条", false), owner("2")];
  const plain: unknown[] = [];
  for (const e of inputs()) plain.push(JSON.stringify(e));
  for (const mode of ["observe", "off"] as const) {
    const w = world(mode), envs = inputs(), got: Delivery[] = [];
    for (const e of envs) got.push(await w.send(e));
    expect(got.map((d) => d.outcome)).toEqual(envs.map(() => ({ kind: "sent" })));
    expect(w.sent.map((s) => s.content)).toEqual(envs.map((e) => e.content));
    expect(envs.map((e) => JSON.stringify({ ...e, meta: { ...e.meta, messageId: "", threadId: "" } })))
      .toEqual(plain.map((s) => JSON.stringify({ ...JSON.parse(s as string), meta: { ...JSON.parse(s as string).meta, messageId: "", threadId: "" } })));
    expect(w.store.queued(P)).toEqual([]);
    const log = w.store.read().log;
    if (mode === "off") expect(log).toEqual([]);
    else expect(log.map((r) => r.send)).toEqual(["digest", "digest", "now", "digest", "digest", "now"]);
  }
});

test("messages to anyone but the active PM pass through untouched and unrecorded", async () => {
  const w = world("on");
  const e = sched("T1");
  e.to = workerTo;
  await w.send(e);
  expect(w.sent).toHaveLength(1);
  expect(w.store.read()).toEqual({ queue: [], log: [] });
});

test("bridge restart: queued entries survive and are delivered exactly once (with the next immediate, or by the window)", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  await w.send(sync());
  w.restart();
  await w.send(owner());
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.content).toContain("2 条");
  await w.send(owner("again"));
  expect(w.sent[1]!.content).toBe("again");

  const v = world("on");
  await v.send(sched("T9"));
  v.restart();
  await v.tick(); // 窗口没到：不送也不丢
  expect(v.sent).toEqual([]);
  expect(v.store.queued(P)).toHaveLength(1);
  v.advance(PM_DIGEST_WINDOW_MS); // 重启后没有任何新投递：启动时挂上的发送入口自己按窗口送出
  await v.tick();
  await v.tick();
  expect(v.sent.filter((s) => s.content.includes("T9"))).toHaveLength(1);
  expect(v.store.queued(P)).toEqual([]);
});

test("a standalone digest held in the PM's queue blocks new ones for a window; an empty replay is dropped", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.advance(PM_DIGEST_WINDOW_MS);
  w.setOutcome({ kind: "sent", note: "queued" });
  await w.tick();
  w.setOutcome({ kind: "sent" });
  await w.tick();
  expect(w.sent).toEqual([]);
  await w.send(owner());
  expect(w.sent).toHaveLength(1);
  const replay = env({ kind: "bridge", label: "pm-digest" }, "", true);
  const r = await w.send(replay);
  expect(r.outcome.kind).toBe("dropped");
  expect(w.sent).toHaveLength(1);
});

test("switching away from on flushes what is left right away", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.store.setMode(P, "off");
  await w.tick();
  expect(w.sent.some((s) => s.content.includes("T1"))).toBe(true);
  expect(w.store.queued(P)).toEqual([]);
});

test("stats: last 24h counts of immediate vs mergeable with source distribution", async () => {
  const w = world("observe");
  await w.send(sched("T1"));
  await w.send(sched("T2"));
  await w.send(owner());
  const s = pmDigestStats(w.store, P, 1_000_000);
  expect(s).toMatchObject({ mode: "observe", now: 1, digest: 2, queued: 0, bySource: { digest: { scheduler: 2 }, now: { user: 1 } } });
  expect(pmDigestStats(w.store, P, 1_000_000 + 25 * 3600_000)).toMatchObject({ now: 0, digest: 0 });
});

test("concurrent immediates (and a window tick racing them) carry the digest exactly once", async () => {
  const w = world("on"), order = createKeyedSerial();
  const slow = (e: Envelope, t: LocalEndpoint) => order(t.channelId, async () => { await Bun.sleep(5); return w.raw(e, t); });
  await w.send(sched("T1"));
  w.advance(PM_DIGEST_WINDOW_MS);
  await Promise.all([w.send(owner("a"), slow), w.send(owner("b"), slow), w.tick()]);
  expect(w.sent.filter((s) => s.content.includes("[📨 PM 摘要]"))).toHaveLength(1);
  expect(w.sent.map((s) => s.content.replace(/^[\s\S]*\n\n/, ""))).toEqual(expect.arrayContaining(["a", "b"]));
  expect(w.store.queued(P)).toEqual([]);
});

test("the window digest uses the startup sender, not a held replay's withdrawn closure", async () => {
  const w = world("on");
  const withdrawn = async (e: Envelope): Promise<Delivery> => ({ envelope: e, outcome: { kind: "dropped", reason: "已从押后队列撤下" } });
  await w.send(owner("押后重投"), withdrawn); // 最近一次投递是一条已撤下的押后条目
  await w.send(sched("T1"));
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.content).toContain("T1");
  expect(w.store.queued(P)).toEqual([]);
});

test("the digest envelope is never queued again even in on mode (no self loop)", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.store.queued(P)).toEqual([]);
  expect(w.store.read().log.map((r) => r.source)).toEqual(["scheduler"]);
});

test("corrupt state: writers refuse to overwrite, the message goes out immediately instead of being swallowed", async () => {
  const w = world("on");
  const path = join(w.dir, "pm-digest.json");
  writeFileSync(path, "{not json");
  const r = await w.send(sched("T1"));
  expect(r.outcome).toEqual({ kind: "sent" });
  expect(w.sent).toHaveLength(1);
  expect(readFileSync(path, "utf-8")).toBe("{not json");
  writeFileSync(join(w.dir, "pm-digest-mode.json"), "[]");
  expect(() => w.store.setMode(P, "on")).toThrow("拒绝覆盖");
  expect(readFileSync(join(w.dir, "pm-digest-mode.json"), "utf-8")).toBe("[]");
});

/** check_inbox({ ack }) 的那两步（bridge/inbox.ts ackBatch）：出队落盘 + 报送达 */
function inboxAck(held: HeldQueue): Envelope[] {
  const items = [...(held.get("ch-pm") ?? [])];
  for (const it of items) { held.remove("ch-pm", it); held.inboxDelivered("ch-pm", it); }
  return items.map((i) => i.env);
}

test("held-inbox: a held immediate carries its digest on disk; after a restart the inbox ack settles it and the window never resends", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.setOutcome({ kind: "sent", note: "queued" });
  await w.send(owner("正文"));
  w.setOutcome({ kind: "sent" });
  w.restart();
  const seen = inboxAck(w.held());
  expect(seen).toHaveLength(1);
  expect(seen[0]!.content).toContain("T1");
  expect(seen[0]!.content).toEndWith("正文");
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  await w.tick();
  expect(w.sent.filter((s) => s.content.includes("T1"))).toEqual([]);
  expect(w.store.read().queue).toEqual([]);
});

test("held-inbox: entries added while the carrier was re-held in memory only (not on disk) go back to the queue on settle", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.setOutcome({ kind: "sent", note: "queued" });
  const e = owner("正文");
  await w.send(e); // 第一次押下落盘：带 T1
  await w.send(sched("T2"));
  await w.send(e); // Stop 重投又押回同一封：hold 认出同一封不落盘，盘上仍只带 T1
  expect(e.content).toContain("T2");
  w.setOutcome({ kind: "sent" });
  w.restart();
  expect(inboxAck(w.held())[0]!.content).not.toContain("T2");
  expect(w.store.queued(P).map((x) => x.card)).toEqual(["T2"]);
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  expect(w.sent.map((s) => s.content.includes("T2") && !s.content.includes("T1"))).toEqual([true]);
});

/** check_inbox 领其中一封并确认（同上，只这一封） */
function inboxAckOne(held: HeldQueue, threadId: string): void {
  const it = (held.get("ch-pm") ?? []).find((i) => i.env.meta.threadId === threadId)!;
  held.remove("ch-pm", it);
  held.inboxDelivered("ch-pm", it);
}

test("carrier-id: two held clicks sharing a messageId each settle only their own digest, across a restart", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.setOutcome({ kind: "sent", note: "queued" });
  const a = owner("点击 A"), b = { ...owner("点击 B"), meta: { ...a.meta, threadId: "click-b" } };
  await w.send(a);
  await w.send(sched("T2"));
  await w.send(b);
  w.setOutcome({ kind: "sent" });
  w.restart();
  expect(w.held().get("ch-pm")).toHaveLength(2);
  inboxAckOne(w.held(), a.meta.threadId);
  expect(w.store.read().queue.map((e) => [e.card, !!e.carriedBy])).toEqual([["T2", true]]); // B 仍押着、仍带着 T2
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  expect(w.sent).toEqual([]); // 窗口不重发 T2
  inboxAckOne(w.held(), "click-b");
  expect(w.store.read().queue).toEqual([]);
  await w.tick();
  expect(w.sent).toEqual([]);
});

test("pm-switch-inbox: the former PM acking its own held chat hands the carried digest back to the on-duty PM", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.setOutcome({ kind: "sent", note: "queued" });
  await w.send(owner("给 A 的直聊"));
  w.setOutcome({ kind: "sent" });
  setMeta(w.db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-b", PM] }); // 切当班到 B
  w.restart();
  inboxAck(w.held()); // 前任 A 领走自己的直聊并确认
  expect(w.store.queued(P).map((e) => e.card)).toEqual(["T1"]);
  w.advance(PM_DIGEST_WINDOW_MS);
  await w.tick();
  expect(w.sent.map((s) => [s.to, s.content.includes("T1")])).toEqual([["agent-b", true]]);
  expect(w.store.read().queue).toEqual([]);
});

test("held-inbox: a held carrier that is discarded or vanished returns its entries to the queue (never swallowed)", async () => {
  const w = world("on");
  await w.send(sched("T1"));
  w.setOutcome({ kind: "sent", note: "queued" });
  await w.send(owner("正文"));
  w.setOutcome({ kind: "sent" });
  expect(w.store.queued(P)).toEqual([]);
  await w.send(owner("别的")); // 被带走的条目不再拼进别的摘要
  expect(w.sent.map((s) => s.content)).toEqual(["别的"]);
  w.held().discard("ch-pm");
  expect(w.store.queued(P)).toHaveLength(1);

  const v = world("on");
  await v.send(sched("T9"));
  v.setOutcome({ kind: "sent", note: "queued" });
  await v.send(owner("正文"));
  v.setOutcome({ kind: "sent" });
  writeFileSync(join(v.dir, "held.json"), "{}"); // 押后队列里没了、也没报结局（如崩溃）：窗口 tick 时放回队再送
  v.advance(PM_DIGEST_WINDOW_MS);
  await v.tick();
  expect(v.sent.filter((s) => s.content.includes("T9"))).toHaveLength(1);
});

test("corrupt-state: malformed queue elements count as corrupt — the message still goes out immediately", async () => {
  const w = world("on");
  const path = join(w.dir, "pm-digest.json");
  writeFileSync(path, JSON.stringify({ queue: [null], log: [] }));
  const r = await w.send(owner("正文"));
  expect(r.outcome).toEqual({ kind: "sent" });
  expect(w.sent.map((s) => s.content)).toEqual(["正文"]);
  await w.send(sched("T1"));
  expect(w.sent).toHaveLength(2);
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ queue: [null], log: [] });
});

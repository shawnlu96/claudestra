/**
 * PM 切换后旧 PM A 押着的消息转给忙碌的当班 PM B（bridge/pm-held-transfer.ts）：真 HeldQueue + flushHeld + deliverPmLocal，
 * send 按 deliverToLocal 的规矩模拟（目标忙 = 原信封押进目标队、回 queued）。不碰生产队列 / 生产 bridge。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [], dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => clearOpenedBy());

const socket = (id: string) => ({ id, send: () => {} }) as unknown as LocalEndpoint["ws"];
const CA = "channel-a", CB = "channel-b", OTHER = "channel-other";
const HEADER = `[系统转交：原收件人 ${A}；当班 PM ${B}]`;
type Receipt = { tokenId: string; agentChannelId: string; agentName: string; messageId: string };

async function world(opts: { path?: string | null } = {}) {
  const f = pmFixture();
  fixtures.push(f);
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const state = await f.deps.read();
  const agents = state.agents.map((a) => (a.name === B ? { ...a, sessionId: "session-b" } : a));
  const clients = new Map<string, { ws: LocalEndpoint["ws"] }>([[CA, { ws: socket("a") }], [CB, { ws: socket("b") }], [OTHER, { ws: socket("o") }]]);
  const busy = new Set<string>(), failing = new Set<string>();
  const sent: { channelId: string; content: string; messageId: string; expectSession?: string; from: string }[] = [];
  const book = new AgentCallBook(null), receipts = new Map<string, Receipt[]>();
  const facts = { db: f.db, agents, principals: async () => ({ principals: state.principals }) };
  let held = new HeldQueue(opts.path ?? null);
  // deliverToLocal 的骨架：撤下的不投；目标忙 → 原信封押进它的队、回 queued；否则 ws.send
  const send = async (env: Envelope, to: LocalEndpoint, stillWanted?: () => boolean): Promise<Delivery> => {
    await Bun.sleep(1);
    if (stillWanted && !stillWanted()) return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } };
    if (failing.has(to.channelId)) return { envelope: env, outcome: { kind: "error", error: new Error("ws closed") } };
    if (busy.has(to.channelId)) {
      held.holdEnv(env);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    sent.push({ channelId: to.channelId, content: env.content, messageId: env.meta.messageId, expectSession: env.meta.expectSession,
      from: env.from.kind === "bridge" ? `bridge:${env.from.label}` : env.from.kind });
    return { envelope: env, outcome: { kind: "sent" } };
  };
  const deps = (): FlushDeps => ({
    held, compacting: () => false, working: async (c) => busy.has(c), isHumanRequest: () => false,
    client: (c) => clients.get(c), touch: () => {}, settled: async () => true, now: () => 1000,
    deliver: (env, to, stillWanted) => deliverPmLocal(env, to, clients, book, receipts, (e, t) => send(e, t, stillWanted), facts),
  });
  const flush = (c: string) => flushHeld(deps(), c, "test");
  const q = (c: string) => held.get(c) ?? [];
  const restart = () => { held = new HeldQueue(opts.path ?? null); };
  return { f, state, clients, busy, failing, sent, book, receipts, facts, flush, q, restart, get held() { return held; } };
}

let seq = 0;
function letter(content = "please review", over: Partial<Envelope> = {}, meta: Partial<Envelope["meta"]> = {}): Envelope {
  return {
    from: { kind: "local", agentName: "agent-task-1", channelId: "sender", ws: socket("sender") },
    to: { kind: "local", agentName: A, channelId: CA, ws: socket("stale") }, intent: "notification", content,
    meta: { messageId: `agent_${++seq}`, triggerKind: "agent_tool", ts: "2026-10-01T00:00:00Z", threadId: `thr-${seq}`, ...meta }, ...over,
  };
}
const holdFor = (h: HeldQueue, env: Envelope, heldAt = 500): HeldItem => {
  const item: HeldItem = { env, to: env.to as LocalEndpoint, heldAt };
  h.set((env.to as LocalEndpoint).channelId, [...(h.get((env.to as LocalEndpoint).channelId) ?? []), item]);
  return item;
};

test("A 的旧通知转给忙碌的 B：只剩 B 的归属，A 不再重转，B 空闲只投一次并清队", async () => {
  const w = await world(), env = letter("notify body", {}, { expectSession: "session-a" });
  holdFor(w.held, env);
  w.busy.add(CB);
  await w.flush(CA);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB).map((i) => i.env)).toEqual([env]);
  for (let i = 0; i < 3; i++) await w.flush(CA);
  await w.flush(CB); // B 还忙：agent 通知不投
  expect(w.q(CB)).toHaveLength(1);
  expect(w.sent).toEqual([]);
  w.busy.delete(CB);
  await w.flush(CB);
  await w.flush(CA);
  await w.flush(CB);
  expect(w.sent).toEqual([{ channelId: CB, content: `${HEADER}\nnotify body`, messageId: env.meta.messageId, expectSession: "session-b", from: "local" }]);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toEqual([]);
});

test("B 一直忙：多次扫描 A / B 都不新增条目、不叠抬头，B 那条的入队时间不被刷新", async () => {
  const w = await world(), env = letter("body");
  holdFor(w.held, env);
  w.busy.add(CB);
  await w.flush(CA);
  const heldAt = w.q(CB)[0]!.heldAt;
  for (let i = 0; i < 4; i++) { await w.flush(CA); await w.flush(CB); }
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toHaveLength(1);
  expect(w.q(CB)[0]!.heldAt).toBe(heldAt);
  expect(env.content).toBe(`${HEADER}\nbody`);
});

test("多个 flush 并发（A 多次 + B）：B 只收到一次，两边队都清空", async () => {
  const w = await world(), env = letter("concurrent");
  holdFor(w.held, env);
  w.busy.add(CB);
  await Promise.all([w.flush(CA), w.flush(CA), w.flush(CB), w.flush(CA)]);
  w.busy.delete(CB);
  await Promise.all([w.flush(CA), w.flush(CB), w.flush(CB), w.flush(CA)]);
  await Promise.all([w.flush(CA), w.flush(CB)]);
  expect(w.sent.map((s) => s.content)).toEqual([`${HEADER}\nconcurrent`]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

test("转交报错：A 原条目留着可重试，回程槽回到 A；别条和别的项目不动；恢复后只投一次", async () => {
  const w = await world(), env = letter("will fail"), other = letter("pushback", {}, { messageId: "agent_reply_9_x" });
  const foreign: Envelope = { ...letter("other project"), to: { kind: "local", agentName: "agent-other", channelId: OTHER, ws: socket("o") } };
  w.book.add(CA, { callerName: "agent-task-1", callerChannelId: "sender", targetName: A, ts: 1, originalReplyChannel: "r" }, env.meta.messageId);
  holdFor(w.held, env);
  holdFor(w.held, foreign);
  w.failing.add(CB);
  w.busy.add(OTHER);
  await w.flush(CA);
  await w.flush(CA);
  expect(w.q(CA).map((i) => i.env)).toEqual([env]);
  expect(w.q(CB)).toEqual([]);
  expect(w.q(OTHER).map((i) => i.env)).toEqual([foreign]);
  expect(w.book.slot(CA, "sender")?.requests?.map((r) => r.messageId)).toEqual([env.meta.messageId]);
  expect(w.book.slot(CB, "sender")?.requests ?? []).toEqual([]);
  expect(env.content).toBe(`${HEADER}\nwill fail`); // 重试两次仍只有一行抬头
  // 前任自己发起问答的回程：A 在线时留给 A，不被转交逻辑碰
  holdFor(w.held, { ...other, intent: "response" });
  w.failing.delete(CB);
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\nwill fail`], [CA, "pushback"]]);
  expect(w.book.slot(CB, "sender")?.requests?.map((r) => r.messageId)).toEqual([env.meta.messageId]);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(OTHER)).toHaveLength(1);
});

test("B 离线：A 的条目留着（不静默丢），B 上线后投一次", async () => {
  const w = await world(), env = letter("offline");
  holdFor(w.held, env);
  const b = w.clients.get(CB)!;
  w.clients.delete(CB);
  await w.flush(CA);
  await w.flush(CA);
  expect(w.q(CA).map((i) => i.env)).toEqual([env]);
  expect(w.sent).toEqual([]);
  w.clients.set(CB, b);
  await w.flush(CA);
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\noffline`]]);
  expect(w.q(CA)).toEqual([]);
});

test("API scope：令牌含 B 的照转、回执跟到 B；范围不含 B 的明确拒收（B 只收一条拒收通知、无原文），别条不动", async () => {
  const w = await world();
  w.state.principals.push({ id: "token:tok_guest", role: "external", agents: [A], createdAt: "2026-01-01" });
  const ok = letter("peer ok", { from: { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" } as Envelope["from"] });
  const bad = letter("guest secret", { from: { kind: "api", tokenId: "tok_guest", name: "guest" } as Envelope["from"] });
  const keep = letter("unrelated", {}, { messageId: "agent_reply_1_y" });
  const receipt = { tokenId: "tok_peer", agentChannelId: CA, agentName: A, messageId: ok.meta.messageId };
  w.receipts.set(`tok_peer|${CA}`, [receipt]);
  for (const e of [ok, bad, keep]) holdFor(w.held, e);
  w.busy.add(CB);
  w.failing.add(CA); // A 自己的回程这一轮发不出去：留着
  await w.flush(CA);
  expect(w.q(CB).map((i) => [i.env === ok, i.env.from.kind])).toEqual([[true, "api"], [false, "bridge"]]); // 拒收通知押在 B 队
  expect(receipt).toMatchObject({ agentChannelId: CB, agentName: B });
  expect(w.q(CB).some((i) => i.env.content.includes("guest secret"))).toBe(false);
  expect(w.q(CA).map((i) => i.env)).toEqual([keep]);
  await w.flush(CA);
  w.busy.delete(CB);
  await w.flush(CB);
  await w.flush(CB); // 外人的消息一轮只投一个发送人的：拒收通知下一趟投
  expect(w.sent.map((s) => [s.from, s.content.includes("guest secret")])).toEqual([["api", false], ["bridge:pm-scope-refusal", false]]);
  expect(w.sent[0]!.content).toBe(`${HEADER}\npeer ok`);
  // B 空闲时：拒收通知直接投一次，原条目摘掉，再扫不重复
  const w2 = await world();
  w2.state.principals.push({ id: "token:tok_guest", role: "external", agents: [A], createdAt: "2026-01-01" });
  holdFor(w2.held, letter("guest secret", { from: { kind: "api", tokenId: "tok_guest", name: "guest" } as Envelope["from"] }));
  await w2.flush(CA);
  await w2.flush(CA);
  expect(w2.sent).toHaveLength(1);
  expect(w2.sent[0]).toMatchObject({ channelId: CB, from: "bridge:pm-scope-refusal" });
  expect(w2.sent[0]!.content).not.toContain("guest secret");
  expect(w2.q(CA)).toEqual([]);
});

test("拒收通知发不出去（报错）：原条目留在 A 等下次，不当成已处理摘掉", async () => {
  const w = await world();
  w.state.principals.push({ id: "token:tok_guest", role: "external", agents: [A], createdAt: "2026-01-01" });
  const bad = letter("guest", { from: { kind: "api", tokenId: "tok_guest", name: "guest" } as Envelope["from"] });
  holdFor(w.held, bad);
  w.failing.add(CB);
  await w.flush(CA);
  expect(w.q(CA).map((i) => i.env)).toEqual([bad]);
  w.failing.delete(CB);
  await w.flush(CA);
  expect(w.q(CA)).toEqual([]);
  expect(w.sent.map((s) => s.from)).toEqual(["bridge:pm-scope-refusal"]);
});

test("抬头幂等：正文里自带的同款抬头逐字保留、不被当标记剥；报错重试 + 落盘重启后仍只加一行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-held-")), path = join(dir, "held.json");
  dirs.push(dir);
  const w = await world({ path }), body = `[系统转交：原收件人 agent-x；当班 PM agent-y]\n  正文第一行\n\n第三行  `;
  holdFor(w.held, letter(body));
  w.failing.add(CB);
  await w.flush(CA);
  await w.flush(CA);
  w.restart();
  await w.flush(CA);
  w.restart();
  w.failing.delete(CB);
  w.busy.add(CB);
  await w.flush(CA);
  w.restart();
  await w.flush(CA);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toHaveLength(1);
  w.busy.delete(CB);
  await w.flush(CB);
  expect(w.sent.map((s) => s.content)).toEqual([`${HEADER}\n${body}`]);
});

test("存量 A/B 双队（同一封、旧版已叠抬头）：摘 A 的归属不再转，B 投一次、正文不再加字；别的项目不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-held-")), path = join(dir, "held.json");
  dirs.push(dir);
  const w = await world({ path });
  const legacy = letter(`${HEADER}\n${HEADER}\nold notice`);
  const original = letter("x");
  // 旧版 deliverPmLocal 原地改过：env.to=B，A 队条目 item.to 仍是 A；B 队押着同一封
  legacy.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
  w.held.set(CA, [{ env: legacy, to: original.to as LocalEndpoint, heldAt: 100 }]);
  w.held.set(CB, [{ env: legacy, to: legacy.to as LocalEndpoint, heldAt: 200 }]);
  const foreign: Envelope = { ...letter("other project"), to: { kind: "local", agentName: "agent-other", channelId: OTHER, ws: socket("o") } };
  holdFor(w.held, foreign);
  w.busy.add(OTHER);
  w.restart(); // 落盘读回：两条不再是同一个对象
  expect(w.q(CA)[0]!.env).not.toBe(w.q(CB)[0]!.env);
  await w.flush(CA);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toHaveLength(1);
  await w.flush(CB);
  await w.flush(CA);
  await w.flush(CB);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\n${HEADER}\nold notice`]]);
  expect(w.q(OTHER)).toHaveLength(1);
});

test("存量：同一 messageId 的两次合法点击各自保留；B 队没有对应的那条再交一次（不叠抬头）后清掉", async () => {
  const w = await world();
  const click = (n: string) => {
    const e = letter(`${HEADER}\nclick`, { from: { kind: "user", userId: "owner-1", username: "owner" } as Envelope["from"] },
      { messageId: "discord-1", threadId: "thr-click", ts: `2026-10-01T00:00:0${n}Z` });
    e.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
    return e;
  };
  const c1 = click("1"), c2 = click("2");
  const aTo: LocalEndpoint = { kind: "local", agentName: A, channelId: CA, ws: socket("a") };
  w.held.set(CA, [{ env: c1, to: aTo, heldAt: 1 }, { env: c2, to: aTo, heldAt: 2 }]);
  w.held.set(CB, [{ env: c1, to: c1.to as LocalEndpoint, heldAt: 3 }]);
  await w.flush(CA);
  await w.flush(CA);
  await w.flush(CB);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\nclick`], [CB, `${HEADER}\nclick`]]);
});

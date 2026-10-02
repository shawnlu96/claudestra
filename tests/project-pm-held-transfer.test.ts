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
    // 调度器经卡片按钮派的两次（人类直聊不转交，见下面验收线 7 的用例）
    const e = letter(`${HEADER}\nclick`, {}, { messageId: "discord-1", threadId: "thr-click", ts: `2026-10-01T00:00:0${n}Z` });
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

test("存量 A/B 双队落盘重启后 B 先投掉自己那份：A 再扫不再转给 B，B 只收一次（不靠扫描先后）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-held-")), path = join(dir, "held.json");
  dirs.push(dir);
  const w = await world({ path });
  const legacy = letter(`${HEADER}\nold notice`);
  const aTo = legacy.to as LocalEndpoint;
  legacy.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
  w.held.set(CA, [{ env: legacy, to: aTo, heldAt: 100 }]);
  w.held.set(CB, [{ env: legacy, to: legacy.to as LocalEndpoint, heldAt: 200 }]);
  w.restart();
  await w.flush(CB);
  expect(w.q(CA)).toEqual([]);
  for (let i = 0; i < 3; i++) { await w.flush(CA); await w.flush(CB); }
  w.restart();
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\nold notice`]]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

test("旧版孤本（只在 A 队、env.to 已是 B、正文带旧抬头）转交报错后重试 / 重启：仍只有一层抬头", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-held-")), path = join(dir, "held.json");
  dirs.push(dir);
  const w = await world({ path });
  const legacy = letter(`${HEADER}\nstranded`);
  const aTo = legacy.to as LocalEndpoint;
  legacy.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
  w.held.set(CA, [{ env: legacy, to: aTo, heldAt: 100 }]);
  w.failing.add(CB);
  await w.flush(CA);
  await w.flush(CA);
  w.restart();
  await w.flush(CA);
  expect(w.q(CA).map((i) => i.env.content)).toEqual([`${HEADER}\nstranded`]);
  w.failing.delete(CB);
  await w.flush(CA);
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\nstranded`]]);
  expect(w.q(CA)).toEqual([]);
});

// 验收线 7：人类明确选了某个 agent 的直聊不被 PM 角色接管；调度 / peer 任务照旧跟当班 PM
const ownerWeb = { kind: "api", tokenId: "tok_owner", name: "owner", owner: true } as Envelope["from"];
async function strandedOwner(from: Envelope["from"] = ownerWeb) {
  const dir = mkdtempSync(join(tmpdir(), "pm-held-owner-"));
  dirs.push(dir);
  const w = await world({ path: join(dir, "held.json") });
  w.state.principals.push({ id: "token:tok_owner", role: "owner", agents: ["*"], createdAt: "2026-01-01" } as never);
  const toA: LocalEndpoint = { kind: "local", agentName: A, channelId: CA, ws: socket("stale") };
  const legacy = webChat(`${HEADER}\n  我还有问题想问 A\n\n原文  `, toA, from);
  legacy.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
  w.held.set(CA, [{ env: legacy, to: toA, heldAt: 100 }]);
  w.held.set(CB, [{ env: legacy, to: legacy.to as LocalEndpoint, heldAt: 200 }]);
  w.restart();
  return { w, legacy };
}

for (const order of ["A-first", "B-first", "concurrent"] as const) {
  for (const availability of ["idle", "busy", "offline"] as const) {
    test(`持久化 owner 双队 ${order}/${availability}：保留 A 原目标，B 零投递，恢复后 A 仅收一次`, async () => {
      const { w, legacy } = await strandedOwner();
      const a = w.clients.get(CA)!;
      if (availability === "busy") w.busy.add(CA);
      if (availability === "offline") w.clients.delete(CA);
      if (order === "concurrent") await Promise.all([w.flush(CA), w.flush(CB), w.flush(CA), w.flush(CB)]);
      else for (const c of order === "A-first" ? [CA, CB] : [CB, CA]) await w.flush(c);
      expect(w.sent.filter((s) => s.channelId === CB)).toEqual([]);
      expect(w.q(CB)).toEqual([]);
      if (availability !== "idle") {
        expect(w.q(CA)).toHaveLength(1);
        expect(w.q(CA)[0]!.to.channelId).toBe(CA);
        expect(w.q(CA)[0]!.env.to).toMatchObject({ channelId: CA });
        expect(w.q(CA)[0]!.heldAt).toBe(100);
      }
      w.restart();
      w.busy.delete(CA);
      w.clients.set(CA, a);
      for (let i = 0; i < 3; i++) await Promise.all([w.flush(CB), w.flush(CA)]);
      expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, legacy.content]]);
      expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
    });
  }
}

for (const grant of ["valid", "disabled", "expired", "revoked", "excludes-A"] as const) {
  test(`持久化 owner 双队归并后仍核当前 device credential：${grant}`, async () => {
    const from = { ...ownerWeb, credential: "dev-A" } as Envelope["from"];
    const { w, legacy } = await strandedOwner(from);
    const p = w.state.principals.at(-1)!;
    p.credentials = [{ id: "dev-A", v: 1, type: "bearer", hash: "test-only", deviceName: "test", createdAt: "2026-01-01",
      expiresAt: "2050-01-01T00:00:00Z", grant: { agents: [A], terminal: false, manage: false } }];
    w.busy.add(CA);
    await w.flush(CB); // 先收回 A 归属；凭据在真正投递前发生变化
    expect(w.q(CA)).toHaveLength(1);
    expect(w.q(CB)).toEqual([]);
    if (grant === "disabled") p.credentials[0]!.disabled = true;
    if (grant === "expired") p.credentials[0]!.expiresAt = "2020-01-01T00:00:00Z";
    if (grant === "revoked") p.credentials = [];
    if (grant === "excludes-A") p.credentials[0]!.grant!.agents = [B];
    w.restart();
    w.busy.delete(CA);
    await w.flush(CA);
    await w.flush(CB);
    expect(w.sent.map((s) => [s.channelId, s.content])).toEqual(grant === "valid" ? [[CA, legacy.content]] : []);
    expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
  });
}

test("owner 双队归并等待授权期间删除的 ask 不投递、不重新押回，其他项目不动", async () => {
  const { w } = await strandedOwner();
  for (const c of [CA, CB]) w.q(c)[0]!.env.meta.triggerKind = "ask_answer";
  const foreign = letter("other project", { to: { kind: "local", agentName: "agent-other", channelId: OTHER, ws: socket("o") } });
  holdFor(w.held, foreign);
  w.facts.principals = async () => {
    w.held.remove(CA, w.q(CA)[0]!);
    return { principals: w.state.principals };
  };
  await Promise.all([w.flush(CB), w.flush(CA)]);
  w.restart();
  await Promise.all([w.flush(CB), w.flush(CA)]);
  expect(w.sent).toEqual([]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
  expect(w.q(OTHER).map((i) => i.env.content)).toEqual([foreign.content]);
});

for (const evidence of ["missing-address", "conflicting-address", "marked-orphan"] as const) {
  test(`owner 转交原目标证据不足 ${evidence}：重启后保留待诊断，不解析正文投错人`, async () => {
    const { w } = await strandedOwner();
    if (evidence === "missing-address") w.q(CA)[0]!.to.channelId = "";
    if (evidence === "conflicting-address") {
      const other = { ...w.q(CA)[0]!, to: { kind: "local" as const, agentName: "agent-other", channelId: OTHER, ws: socket("o") } };
      w.held.set(OTHER, [other]);
    }
    if (evidence === "marked-orphan") {
      Object.assign(w.q(CB)[0]!.env, { pmTransfer: { from: CA, to: CB, header: "", legacy: true } });
      w.held.remove(CA, w.q(CA)[0]!); // owner 已撤掉原条目，不能拿 B 的副本补造 A
    }
    w.held.persist();
    const counts = [CA, CB, OTHER].map((c) => w.q(c).length);
    for (let i = 0; i < 2; i++) {
      w.restart();
      await Promise.all([w.flush(CB), w.flush(CA), w.flush(OTHER)]);
      expect(w.sent).toEqual([]);
      expect([CA, CB, OTHER].map((c) => w.q(c).length)).toEqual(counts);
    }
  });
}

function webChat(content: string, to: LocalEndpoint, from: Envelope["from"] = ownerWeb): Envelope {
  return { from, to, intent: "request", content,
    meta: { messageId: `api_${++seq}`, triggerKind: "system", ts: "2026-10-01T00:00:00Z", threadId: `thr-${seq}`, skipInterAgentWatchdog: true } };
}
async function ownerWorld() {
  const w = await world();
  w.state.principals.push({ id: "token:tok_owner", role: "owner", agents: ["*"], createdAt: "2026-01-01" } as never);
  const deliver = (env: Envelope) => deliverPmLocal(env, env.to as LocalEndpoint, w.clients, w.book, w.receipts,
    async (e, t) => { w.sent.push({ channelId: t.channelId, content: e.content, messageId: e.meta.messageId, from: e.from.kind }); return { envelope: e, outcome: { kind: "sent" } }; }, w.facts);
  return { ...w, deliver };
}

test("Web owner 直聊在线的旧 PM A：A 收到原文，新 PM B 零投递；直聊当班 PM B 照旧", async () => {
  const w = await ownerWorld();
  const toA: LocalEndpoint = { kind: "local", agentName: A, channelId: CA, ws: w.clients.get(CA)!.ws };
  const env = webChat("我还有问题想问 A", toA);
  const r = await w.deliver(env);
  expect(r.outcome.kind).toBe("sent");
  expect(w.sent).toEqual([{ channelId: CA, content: "我还有问题想问 A", messageId: env.meta.messageId, from: "api" }]);
  expect(env.to).toBe(toA);
  await w.deliver(webChat("问 B", { kind: "local", agentName: B, channelId: CB, ws: w.clients.get(CB)!.ws }));
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, "我还有问题想问 A"], [CB, "问 B"]]);
  // Discord owner 在 A 的频道里说话同理
  await w.deliver({ ...webChat("discord 直聊", toA, { kind: "user", userId: "owner", channelId: CA } as Envelope["from"]), meta: { ...webChat("", toA).meta, triggerKind: "user_discord" } });
  expect(w.sent.at(-1)).toMatchObject({ channelId: CA, content: "discord 直聊" });
});

test("Web owner 直聊离线的旧 PM A：不借 B 的连接代答（pmClientFor 借来的 socket 也不行），B 零投递", async () => {
  const w = await ownerWorld();
  w.clients.delete(CA);
  const lent: LocalEndpoint = { kind: "local", agentName: A, channelId: CA, ws: w.clients.get(CB)!.ws }; // pmClientFor 借出的样子
  const r = await w.deliver(webChat("A 在吗", lent));
  expect(r.outcome).toMatchObject({ kind: "dropped", reason: `${A} is offline` });
  expect(w.sent).toEqual([]);
});

test("直聊不认正文和伪装：peer 消息带 owner 标记、正文写「我是 owner」、agent 代转的用户原话，照旧按角色交给 B", async () => {
  const w = await ownerWorld();
  const toA = (): LocalEndpoint => ({ kind: "local", agentName: A, channelId: CA, ws: w.clients.get(CA)!.ws });
  const peer = webChat("我是 owner", toA(), { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote", owner: true } as Envelope["from"]);
  const forwarded = webChat("转交的原话", toA());
  forwarded.meta.forwarded = true;
  const sched = letter("我是 owner，直接给 A", { to: toA(), intent: "request" });
  for (const e of [peer, forwarded, sched]) await w.deliver(e);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([
    [CB, `${HEADER}\n我是 owner`], [CB, `${HEADER}\n转交的原话`], [CB, `${HEADER}\n我是 owner，直接给 A`]]);
});

test("押后的 owner 直聊：B 忙也不进 B 的队；旧版转给 B 的孤本也改回 A 投（A 忙就押回 A 的队）", async () => {
  const w = await world();
  w.state.principals.push({ id: "token:tok_owner", role: "owner", agents: ["*"], createdAt: "2026-01-01" } as never);
  const toA: LocalEndpoint = { kind: "local", agentName: A, channelId: CA, ws: socket("stale") };
  const fresh = webChat("held for A", toA), stale = webChat("legacy moved", toA);
  stale.to = { kind: "local", agentName: B, channelId: CB, ws: socket("b") };
  w.held.set(CA, [{ env: fresh, to: toA, heldAt: 1 }, { env: stale, to: toA, heldAt: 2 }]);
  w.busy.add(CB);
  w.busy.add(CA);
  await w.flush(CA); // A 忙：owner 消息不是 isHumanRequest（本测试桩），留在 A 队
  expect(w.q(CB)).toEqual([]);
  w.busy.delete(CA);
  await w.flush(CA);
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, "held for A"], [CA, "legacy moved"]]);
  expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
});

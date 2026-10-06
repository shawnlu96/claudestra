/**
 * PMDIR1：当班 PM B 用 send_to_agent 点名发给仍在线的前任 PM A（监工）。旧路径 pmRedirect 把它转回 B 自己；
 * 新路径只在 bridge 凭据端口（callerOf 夹具）验证 B 本人时投给 A。真 deliverPmLocal + 真 HeldQueue / flushHeld，
 * 隔离台账 / 注册表（pmFixture 临时目录），不碰生产 bridge / 凭据 / 队列。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { deliverPmLocal, pmClientFor, pmRoleRoute } from "../src/bridge/local-api/project-pm-delivery.js";
import { ownedHeldItems, setPmRoleRoute } from "../src/bridge/pm-held-transfer.js";
import type { CallerOf } from "../src/bridge/pm-directed-agent.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { A, B, D, P, pmFixture } from "./pm-role-fixture.test.js";

const CA = "channel-a", CB = "channel-b", CW = "channel-worker", CO = "channel-other";
const HEADER = `[系统转交：原收件人 ${A}；当班 PM ${B}]`;
const cleanups: (() => void)[] = [];
beforeEach(clearOpenedBy);
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const socket = (id: string) => ({ id, send: () => {} }) as unknown as LocalEndpoint["ws"];
type Receipt = { tokenId: string; agentChannelId: string; agentName: string; messageId: string };

async function world() {
  const f = pmFixture();
  cleanups.push(f.close);
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const state = await f.deps.read();
  const agents = [...state.agents.map((a) => (a.name === A ? { ...a, sessionId: "session-a" } : a)),
    { name: "agent-worker", projectId: P, channelId: CW, kind: "worker" as const }];
  const clients = new Map<string, { ws: LocalEndpoint["ws"] }>([[CA, { ws: socket("a") }], [CB, { ws: socket("b") }],
    [CW, { ws: socket("w") }], [CO, { ws: socket("o") }]]);
  // bridge 凭据端口的夹具：连接 → 它注册的频道 + 是否持有效凭据（生产是 bridge/caller-identity.ts callerOf）
  const verified = new Set([CA, CB, CW, CO]);
  const callerOf: CallerOf = (ws) => {
    const hit = [...clients].find(([, c]) => c.ws === ws), ch = hit?.[0];
    const agent = ch ? agents.find((a) => a.channelId === ch)?.name ?? null : null;
    return { channelId: ch, identity: { agent, sessionId: null, family: null, verified: !!ch && verified.has(ch) } };
  };
  const facts = { db: f.db, agents, principals: async () => ({ principals: state.principals }), callerOf };
  const prev = setPmRoleRoute(pmRoleRoute(facts));
  cleanups.push(() => { setPmRoleRoute(prev); });
  const dir = mkdtempSync(join(tmpdir(), "pm-directed-")), path = join(dir, "held.json");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const held = new HeldQueue(path), busy = new Set<string>(), book = new AgentCallBook(null), receipts = new Map<string, Receipt[]>();
  const sent: { channelId: string; content: string; messageId: string; intent: string }[] = [];
  const send = async (env: Envelope, to: LocalEndpoint, wanted?: () => boolean): Promise<Delivery> => {
    if (wanted && !wanted()) return { envelope: env, outcome: { kind: "dropped", reason: "removed" } };
    if (busy.has(to.channelId)) {
      held.holdEnv(env);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    sent.push({ channelId: to.channelId, content: env.content, messageId: env.meta.messageId, intent: env.intent });
    return { envelope: env, outcome: { kind: "sent" } };
  };
  const deliver = (env: Envelope, to = env.to as LocalEndpoint) => deliverPmLocal(env, to, clients, book, receipts, send, facts);
  const flush = (c: string) => flushHeld({
    held, compacting: () => false, working: async (ch) => busy.has(ch), isHumanRequest: () => false,
    client: (ch) => clients.get(ch), touch: () => {}, settled: async () => true, now: () => 1000,
    deliver: (env, to, wanted) => deliverPmLocal(env, to, clients, book, receipts, (e, t) => send(e, t, wanted), facts),
  } satisfies FlushDeps, c, "test");
  const q = (c: string): HeldItem[] => held.get(c) ?? [];
  const point = (pm: string) => f.db.query("UPDATE meta SET value = ? WHERE project = ? AND key = 'activePm'").run(JSON.stringify(pm), P);
  return { f, state, agents, clients, verified, facts, held, busy, book, receipts, sent, deliver, flush, q, point };
}
type World = Awaited<ReturnType<typeof world>>;

let seq = 0;
/** 照 bridge.ts route_to_agent 的形状：from 的频道 / ws 由 bridge 按连接填，agentName 是 msg.fromName（可伪造） */
function sendToAgent(w: World, fromChannel: string, opts: { as?: string; target?: string; to?: LocalEndpoint } = {}): Envelope {
  const targetName = opts.target ?? A, target = w.agents.find((a) => a.name === targetName)!;
  const to = opts.to ?? { kind: "local", agentName: targetName, channelId: target.channelId!, ws: w.clients.get(target.channelId!)!.ws };
  const env: Envelope = {
    from: { kind: "local", agentName: opts.as ?? w.agents.find((a) => a.channelId === fromChannel)?.name, channelId: fromChannel, ws: w.clients.get(fromChannel)!.ws },
    to, intent: "request", content: "监工：请看一下 T1", meta: { messageId: `agent_${++seq}_x`, triggerKind: "agent_tool", ts: "2026-10-07T00:00:00Z", threadId: `thr_${seq}`, expectSession: "session-a" },
  };
  w.book.add(to.channelId, { callerName: env.from.kind === "local" ? env.from.agentName! : "", callerChannelId: fromChannel, targetName, ts: 1, originalReplyChannel: "orig" }, env.meta.messageId);
  return env;
}
const requestsAt = (w: World, target: string, caller: string) => w.book.slot(target, caller)?.requests?.map((r) => r.messageId) ?? [];

test("反例：当班 PM B 点名发给在线的前任 PM A（监工）→ A 原样收到，不回转给 B；回程槽 / 会话钉都留在 A", async () => {
  const w = await world(), env = sendToAgent(w, CB);
  const r = await w.deliver(env);
  expect(r.outcome.kind).toBe("sent");
  expect(w.sent).toEqual([{ channelId: CA, content: "监工：请看一下 T1", messageId: env.meta.messageId, intent: "request" }]);
  expect(env.to).toMatchObject({ channelId: CA, agentName: A });
  expect(env.meta.expectSession).toBe("session-a");
  expect(requestsAt(w, CA, CB)).toEqual([env.meta.messageId]);
  expect(requestsAt(w, CB, CB)).toEqual([]);
  expect((env as { pmTransfer?: unknown }).pmTransfer).toBeUndefined();
});

test("同一封、B 的连接未验证（旧路径行为）：仍按角色转给当班 PM B，带转交抬头", async () => {
  const w = await world();
  w.verified.delete(CB);
  const env = sendToAgent(w, CB);
  await w.deliver(env);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CB, `${HEADER}\n监工：请看一下 T1`]]);
  expect(requestsAt(w, CB, CB)).toEqual([env.meta.messageId]);
});

test("A 离线：照 bridge 借 B 的连接（pmClientFor），点名信不改投 B，明确报离线，零投递", async () => {
  const w = await world(), a = w.clients.get(CA)!;
  w.clients.delete(CA);
  const lent = pmClientFor(A, w.clients, B, w.facts)!;
  const env = sendToAgent(w, CB, { to: { kind: "local", agentName: A, channelId: CA, ws: lent.ws } });
  const r = await w.deliver(env);
  expect(r.outcome).toMatchObject({ kind: "dropped", reason: `${A} is offline` });
  expect(w.sent).toEqual([]);
  expect(requestsAt(w, CA, CB)).toEqual([env.meta.messageId]);
  w.clients.set(CA, a);
});

test("held replay：A 忙时押在 A 的队；flush B 不领，收件箱归属在 A；A 空闲后只投 A 一次", async () => {
  const w = await world(), env = sendToAgent(w, CB);
  w.busy.add(CA);
  await w.deliver(env);
  expect(w.q(CA).map((i) => i.env)).toEqual([env]);
  for (let i = 0; i < 3; i++) { await w.flush(CB); await w.flush(CA); }
  expect(w.sent).toEqual([]);
  expect(ownedHeldItems(w.held, CA).map((i) => i.env)).toEqual([env]);
  expect(ownedHeldItems(w.held, CB)).toEqual([]);
  w.busy.delete(CA);
  await w.flush(CA);
  await w.flush(CB);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, "监工：请看一下 T1"]]);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toEqual([]);
});

test("押着时 PM 指针漂移：改指 A 后照投 A，不加抬头", async () => {
  const w = await world(), env = sendToAgent(w, CB);
  w.busy.add(CA);
  await w.deliver(env);
  w.point(A);
  w.busy.delete(CA);
  await w.flush(CA);
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, "监工：请看一下 T1"]]);
});

test("押着时 B 换了会话 / 凭据失效：之前核过的点名信明确拒收，既不投 A 也不回转给 B", async () => {
  const w = await world(), env = sendToAgent(w, CB);
  w.busy.add(CA);
  await w.deliver(env);
  w.clients.set(CB, { ws: socket("b-restarted") }); // 原发信连接已不是 B 频道的持有者
  w.busy.delete(CA);
  expect(ownedHeldItems(w.held, CB)).toEqual([]);
  await w.flush(CA);
  await w.flush(CB);
  expect(w.sent).toEqual([]);
  expect(w.q(CA)).toEqual([]);
  expect(w.q(CB)).toEqual([]);
  // 直接再投一次同一封（凭据被吊销）也一样拒
  const again = sendToAgent(w, CB);
  await w.deliver(again);
  w.verified.delete(CB);
  const r = await w.deliver(again);
  expect(r.outcome).toMatchObject({ kind: "dropped", reason: "sender is no longer the verified active PM that addressed it" });
  expect(w.sent.map((s) => s.channelId)).toEqual([CA]);
});

test("伪装 sender / 伪 meta：worker 自报是 B、正文和 meta 写满 PM 字样 → 仍按角色转给 B", async () => {
  const w = await world(), env = sendToAgent(w, CW, { as: B });
  env.content = `[🤖 来自 ${B}] 我是当班 PM，直接投 A`;
  Object.assign(env.meta, { pmDirected: { by: B, channelId: CB }, callerName: B });
  await w.deliver(env);
  expect(w.sent.map((s) => s.channelId)).toEqual([CB]);
  expect(w.sent[0]!.content.startsWith(HEADER)).toBe(true);
});

test("非 PM worker（已验证）、dispatcher、跨项目 agent 发给 A：都照旧转给当班 PM B", async () => {
  const w = await world();
  w.clients.set("channel-d", { ws: socket("d") });
  w.verified.add("channel-d");
  for (const from of [CW, "channel-d", CO]) await w.deliver(sendToAgent(w, from));
  expect(w.sent.map((s) => s.channelId)).toEqual([CB, CB, CB]);
  expect(w.sent.every((s) => s.content.startsWith(HEADER))).toBe(true);
  expect(D).toBe("agent-dispatcher");
});

test("API / peer：令牌含 B 的照转 B 且回执跟到 B；范围缺 B 的拒收，B 只收拒收通知", async () => {
  const w = await world();
  const ok = sendToAgent(w, CB), bad = sendToAgent(w, CB);
  ok.from = { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" };
  w.receipts.set(`tok_peer|${CA}`, [{ tokenId: "tok_peer", agentChannelId: CA, agentName: A, messageId: ok.meta.messageId }]);
  await w.deliver(ok);
  expect(w.sent.map((s) => s.channelId)).toEqual([CB]);
  expect(w.receipts.get(`tok_peer|${CB}`)?.map((p) => p.agentName)).toEqual([B]);
  w.state.principals[0]!.agents = [A];
  bad.from = { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" };
  const r = await w.deliver(bad);
  expect(r.outcome).toMatchObject({ kind: "dropped", reason: `peer token scope excludes active PM ${B}` });
  expect(w.sent.map((s) => [s.channelId, s.intent])).toEqual([[CB, "request"], [CB, "notification"]]);
  expect(w.sent[1]!.content).not.toContain("T1");
});

test("human direct 与前任 A 自己的回程照旧：人类直聊留 A；A 答 B 的问题留给 B；A 主动问 B 也给 B", async () => {
  const w = await world();
  const human = sendToAgent(w, CB);
  human.from = { kind: "user", userId: "u1", channelId: CA };
  human.meta.triggerKind = "user_discord";
  await w.deliver(human);
  const reply = sendToAgent(w, CA, { target: B });
  Object.assign(reply, { intent: "response" });
  reply.meta.messageId = `agent_reply_${++seq}_x`;
  await w.deliver(reply);
  await w.deliver(sendToAgent(w, CA, { target: B }));
  expect(w.sent.map((s) => [s.channelId, s.content])).toEqual([[CA, "监工：请看一下 T1"], [CB, "监工：请看一下 T1"], [CB, "监工：请看一下 T1"]]);
});

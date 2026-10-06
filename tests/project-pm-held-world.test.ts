/**
 * 押后队列 + 收件箱 + flush + deliverPmLocal 的真实小世界（tests/project-pm-held-inbox.test.ts、tests/project-pm-held-switch.test.ts 共用）：
 * held 真落盘可重载，PM 切换走真实 switchProjectPm，回执走真实 takeApiWaiters。本文件不含测试
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { subscribeEvents } from "../src/bridge/event-bus.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { deliverPmLocal, pmRoleRoute } from "../src/bridge/local-api/project-pm-delivery.js";
import { setPmRoleRoute } from "../src/bridge/pm-held-transfer.js";
import { takeApiWaiters, type ApiWaiter } from "../src/bridge/stop-settle.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { holdsUntilIdle } from "../src/lib/turn-state.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

export const CA = "channel-a", CB = "channel-b", OTHER = "channel-other";
export const BODY = "[系统转交：原收件人 agent-alpha；当班 PM agent-beta]\n  我还有问题想问 A\n\n原文  ";
const cleanups: (() => void)[] = [];
/** 每个用到 inboxWorld 的测试文件顶层调一次：每条测试前清分轮记录，结束后关掉夹具 */
export function useInboxWorld(): void {
  beforeEach(clearOpenedBy);
  afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
}
export const ws = (id: string) => ({ id, send: () => {} }) as unknown as LocalEndpoint["ws"];
export const target = (channelId: string): LocalEndpoint => ({ kind: "local", channelId, agentName: channelId === CA ? A : B, ws: ws(channelId) });

export async function inboxWorld() {
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
  const calls = new AgentCallBook(null), busy = new Set<string>(), receipts = new Map<string, ApiWaiter[]>();
  // onProbe：判忙 / 画面静止这些 await 窗口里插一手（owner 切 PM）；idleRule：发送时按生产 holdsUntilIdle 判押（API 请求不带 waitForIdle 忙也发）
  const opts: { busyOnSend: boolean; idleRule?: boolean; onProbe?: (c: string) => Promise<boolean> } = { busyOnSend: false };
  const probe = async (c: string) => { if (await opts.onProbe?.(c)) opts.onProbe = undefined; }; // 返回 true = 插过了，只插一次
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
      held, compacting: () => false, working: async (c) => { await probe(c); return busy.has(c); }, isHumanRequest: () => false,
      client: (c) => clients.get(c), touch: (c, e) => calls.touchDelivered(c, e), settled: async (c) => { await probe(c); return true; }, now: () => 1000,
      deliver: (env, to, wanted) => deliverPmLocal(env, to, clients, calls, receipts, async (e, t) => {
        if (wanted && !wanted()) return { envelope: e, outcome: { kind: "dropped", reason: "removed" } };
        if (opts.idleRule ? holdsUntilIdle(e.from.kind, e.meta.waitForIdle, { main: busy.has(t.channelId) ? "busy" : "idle" } as never) : busy.has(t.channelId)) {
          held.holdEnv(e);
          return { envelope: e, outcome: { kind: "sent", note: "queued" } };
        }
        sent.push({ channel: t.channelId, text: e.content });
        if (opts.busyOnSend) busy.add(t.channelId); // 投进去就开了一轮
        return { envelope: e, outcome: { kind: "sent" } };
      }, { db: fixture.db, agents: state.agents, principals: async () => ({ principals: state.principals }) }),
    };
    return flushHeld(d, channel, "inbox-test");
  };
  const restart = () => { held = new HeldQueue(path); init(); };
  const q = (c: string) => held.get(c) ?? [];
  const scope = (agents: string[]) => { Object.assign(state.principals.find((p) => p.id === "token:tok_peer")!, { agents }); };
  const principal = (p: Record<string, unknown>) => { state.principals.push(p as never); };
  return { get held() { return held; }, take, flush, restart, q, scope, principal, opts, receipts, clients, calls, busy, sent, rendered, mirrors, fixture };
}

export function ownerLetter(text = BODY): Envelope {
  return {
    from: { kind: "api", tokenId: "tok_owner", name: "owner", owner: true }, to: target(CB), intent: "request", content: text,
    meta: { messageId: "same-button", threadId: "owner-thread", ts: "2026-10-01T00:00:00Z", triggerKind: "system" },
  };
}
export type World = Awaited<ReturnType<typeof inboxWorld>>;

export function preSwitchRole(w: World, text = "  pre-switch role body\n\nunchanged  ", patch: (env: Envelope) => void = () => {}): HeldItem {
  const env = ownerLetter(text);
  env.intent = "notification";
  env.to = target(CA);
  env.from = { kind: "local", agentName: "agent-task-1", channelId: "executor", ws: ws("exec") };
  patch(env);
  w.held.set(CA, [...w.q(CA), { env, to: target(CA), heldAt: 100 }]);
  w.restart(); // 旧数据从盘上读回
  return w.q(CA).at(-1)!;
}
export const HEADER = `[系统转交：原收件人 ${A}；当班 PM ${B}]`;

export function peerRequest(w: World, id: string, tokenId: string, peer: string): void {
  preSwitchRole(w, `${id} body`, (env) => {
    env.from = { kind: "api", tokenId, peer, name: peer };
    env.intent = "request";
    env.meta = { ...env.meta, messageId: id, threadId: `thread-${id}` };
  });
  w.receipts.set(`${tokenId}|${CA}`, [{ agentChannelId: CA, agentName: A, tokenId, messageId: id, threadId: `thread-${id}` }]);
}
export const stopB = (w: World, text: string) => takeApiWaiters(w.receipts, {
  cid: CB, stopChannelId: CB, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text },
}, true, new Set(), w.held.ids(CB)).map((s) => ({ peer: s.waiter.tokenId, reply: s.result.reply }));
export const stopA = (w: World, text: string) => takeApiWaiters(w.receipts, {
  cid: CA, stopChannelId: CA, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text },
}, true, new Set(), w.held.ids(CA)).map((s) => ({ peer: s.waiter.tokenId, reply: s.result.reply }));

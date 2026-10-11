/**
 * followup-reliability-HELD1 第 2 轮复核的四条：Codex 菜单关了之后批次过不去真的 holdAtCodexMenu、已有租约的重读不核额度闸、
 * 队里只有同一条通知的两份时各投一次 / 各领一条、渲染期间 PM 切走旧 PM 仍领到。真的 HeldQueue + flushHeld + takeInbox +
 * holdAtCodexMenu / createQuotaWall / setPmRoleRoute；投递层的替身同 tests/held-idle-batch-flush.test.ts（那个文件已到行数上限）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { holdAtCodexMenu } from "../src/bridge/codex-menu-hold.js";
import { clearOpenedBy, flushHeld, onHeldDelivered, productionIdleControl, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldIdleControl, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { setPmRoleRoute } from "../src/bridge/pm-held-transfer.js";
import { createQuotaWall } from "../src/bridge/quota-wall.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { HELD_IDLE_BATCH_ENV, type IdleRegistryRow } from "../src/lib/held-idle-batch.js";
import { INBOX_MAX_CHARS, parseInboxBatch } from "../src/lib/inbox-batch.js";

const ws = { tag: "pm-ws" } as never;
const PM = "c-pm";
const to: LocalEndpoint = { kind: "local", channelId: PM, agentName: "agent-pm", ws };
const rows: IdleRegistryRow[] = [
  { name: "agent-pm", status: "active", channelId: PM, sessionId: "sess-1", projectId: "proj-1" },
  { name: "agent-worker", status: "active", channelId: "c-worker", sessionId: "sess-w", projectId: "proj-1" },
  { name: "agent-other", status: "active", channelId: "c-other", sessionId: "sess-o", projectId: "proj-2" },
];

type From = "audit" | "ledger" | "worker" | "other" | "guest" | "peer";
function msg(id: string, heldAt: number, from: From = "audit", over: Partial<Envelope["meta"]> = {}, intent: Envelope["intent"] = "notification"): HeldItem {
  const f: Envelope["from"] = from === "audit" || from === "ledger" ? { kind: "bridge", label: from === "audit" ? "ledger-audit" : "ledger" }
    : from === "worker" ? { kind: "local", channelId: "c-worker", agentName: "agent-worker", ws }
    : from === "other" ? { kind: "local", channelId: "c-other", agentName: "agent-other", ws }
    : { kind: "api", tokenId: `tok-${from}`, name: from, ...(from === "peer" ? { peer: "peer-1" } : {}) };
  const internal = f.kind === "bridge" || f.kind === "local";
  const env = {
    from: f, to, intent, content: `body ${id}`,
    meta: { messageId: id, threadId: `thr-${id}`, ts: `2026-10-11T00:00:${String(heldAt % 60).padStart(2, "0")}Z`,
      triggerKind: f.kind === "bridge" ? "bridge_synth" : f.kind === "local" ? "agent_tool" : "discord",
      ...(internal && intent === "notification" ? { waitForIdle: true } : {}), ...over },
  } as Envelope;
  return { env, to, heldAt };
}

interface Sent { content: string; id: string; from: string; at: number }
/** 一个「一直忙」的 PM：每送出一条就开一轮（忙），stop() 结束这一轮 */
function bridge(items: HeldItem[], control: HeldIdleControl | "default" | undefined, path: string | null = null) {
  const held = new HeldQueue(path, control === "default" ? undefined : control);
  if (control === undefined) held.configureIdleBatch(undefined); // 明确关掉（旧路径）
  for (const i of items) held.hold(PM, i);
  const sends: Sent[] = [], touched: string[] = [];
  let busy = false, online = true, walled = false, compacting = false, session = "sess-1", turnAt: number | undefined, clock = 10;
  const calls = new AgentCallBook(null);
  const clients = new Map([[PM, { ws }]]);
  let onRender: (() => void) | undefined;
  const render = async (e: Envelope) => { onRender?.(); return `${e.meta.interruptNote ?? ""}${e.content}`; };
  initInbox({ held, clients, calls, render, emitIn: () => {}, stoppedAt: () => undefined, walled: (c) => deps.walled!(c) });
  const hooks: ((e: Envelope) => Delivery | undefined)[] = [];
  const deliver: FlushDeps["deliver"] = async (env, _to, stillWanted) => {
    await Promise.resolve(); // deliverToLocal 在发送前有几处 await（判忙、额度闸）
    for (const h of hooks) { const r = h(env); if (r) return r; }
    if (stillWanted && !stillWanted()) return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } };
    if (env.meta.expectSession && env.meta.expectSession !== session) return { envelope: env, outcome: { kind: "dropped", reason: "session mismatch" } };
    const waits = env.from.kind === "local" || !!env.meta.waitForIdle;
    if (compacting || (busy && waits)) {
      held.holdEnv(env, walled ? "quota_wall" : undefined);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    if (walled && waits) {
      held.holdEnv(env, "quota_wall");
      return { envelope: env, outcome: { kind: "sent", note: "queued", heldBy: "quota_wall" } };
    }
    sends.push({ content: String(env.content), id: env.meta.messageId, from: env.from.kind === "bridge" ? `bridge:${env.from.label}` : env.from.kind, at: clock });
    busy = true;
    turnAt ??= clock++;
    return { envelope: env, outcome: { kind: "sent" } };
  };
  const deps: FlushDeps = {
    held, compacting: () => compacting, working: async () => busy, isHumanRequest: (e) => e.from.kind === "user" && e.intent === "request",
    client: () => (online ? { ws } : undefined), deliver, walled: async () => walled, touch: (_c, e) => touched.push(e.meta.messageId),
    settled: async () => true, turnAt: () => turnAt, now: () => 5_000,
  };
  return {
    held, deps, sends, touched, hooks,
    /** 渲染（check_inbox / 批次逐条）的 await 期间插一脚 */
    duringRender: (fn: (() => void) | undefined) => { onRender = fn; },
    ids: () => (held.get(PM) ?? []).map((i) => i.env.meta.messageId),
    /** 这一轮结束，2 秒后的 Stop 补投 */
    stop: async () => { busy = false; turnAt = undefined; await flushHeld(deps, PM, "stop"); },
    /** 回合结束后 3 秒内别处又开了一轮（人类消息直接送进来、CC 自己续跑），之后才轮到 Stop 的补投 */
    stopThenNewTurn: async () => { busy = true; turnAt = clock++; await flushHeld(deps, PM, "stop"); },
    sweep: () => flushHeld(deps, PM, "sweep"),
    set: (s: Partial<{ busy: boolean; online: boolean; walled: boolean; compacting: boolean; session: string; turnAt: number | undefined }>) => {
      ({ busy = busy, online = online, walled = walled, compacting = compacting, session = session } = s);
      if ("turnAt" in s) turnAt = s.turnAt;
    },
    inbox: async (opts: Parameters<typeof takeInbox>[2] = {}, now = Date.now()) => {
      const r = await takeInbox(ws, now, opts);
      if ("error" in r) throw new Error(r.error);
      return r.result;
    },
  };
}
const on = (over: Partial<HeldIdleControl> = {}): HeldIdleControl => ({ ...productionIdleControl({ [HELD_IDLE_BATCH_ENV]: "on" }, () => rows as never), ...over });
/** 载体正文里逐条的原始信息行 */
const originals = (content: string) => [...content.matchAll(/^\[\d+\/\d+ (\{.*\})\]$/gm)].map((m) => JSON.parse(m[1]) as
  { from: { kind: string; label?: string; channelId?: string; agentName?: string }; message_id: string; intent: string; thread: string; ts: string; heldAt: number });

const offHooks: (() => void)[] = [];
beforeEach(() => clearOpenedBy());
afterEach(() => { for (const f of offHooks.splice(0)) f(); });
// onHeldDelivered 没有退订（生产只登记一次）：这里只让每个用例看自己的那份记录
function onHeld(fn: Parameters<typeof onHeldDelivered>[0]): () => void {
  let live = true;
  onHeldDelivered((c, e) => { if (live) fn(c, e); });
  return () => { live = false; };
}
function rig(items: HeldItem[], control: HeldIdleControl | "default" | undefined, path: string | null = null) {
  const b = bridge(items, control, path);
  const delivered: string[] = [];
  offHooks.push(onHeld((_c, e) => delivered.push(e.meta.messageId)));
  return { ...b, delivered };
}

describe("第 2 轮复核：菜单恢复 / 重读核闸 / 只有重复条目 / PM 切换", () => {
  const two = () => [msg("audit-1", 1000), msg("audit-2", 2000)];
  /** 投递层换成真的 holdAtCodexMenu 在前（bridge.ts deliverToLocal 对 Codex 窗口的第一道闸），画面由 menu 注入 */
  function codex(b: ReturnType<typeof rig>) {
    const send = b.deps.deliver, screen = { menu: true };
    b.deps.deliver = async (e, t, w) => (await holdAtCodexMenu(e, t, "agent-pm", "win", b.held, w, async () => (screen.menu ? "codex_menu" : null))) ?? send(e, t, w);
    return screen;
  }

  test("Codex 菜单开着时押下两条巡检，菜单关了之后的 Stop：载体按补投中的那一条过真的 holdAtCodexMenu，一次送出；旧路径对照逐条送完", async () => {
    for (const mode of ["on", "off"] as const) {
      clearOpenedBy();
      const b = rig(two(), mode === "on" ? on() : undefined);
      const screen = codex(b);
      await b.stop(); // 菜单还开着：一个键都不发，原条目原样
      expect(b.sends).toEqual([]);
      expect((b.held.get(PM) ?? []).map((i) => [i.env.meta.messageId, i.heldAt])).toEqual([["audit-1", 1000], ["audit-2", 2000]]);
      screen.menu = false;
      for (let k = 0; k < 3; k++) await b.stop();
      expect(b.ids()).toEqual([]);
      if (mode === "off") expect(b.sends.map((s) => s.id)).toEqual(["audit-1", "audit-2"]);
      else {
        expect(b.sends).toHaveLength(1);
        expect(originals(b.sends[0].content).map((o) => [o.message_id, o.heldAt])).toEqual([["audit-1", 1000], ["audit-2", 2000]]);
        expect(b.delivered).toEqual(["audit-1", "audit-2"]);
      }
      // 补投完了：之后直投的消息不再被「押着的还没补投完」排到后面
      const next = msg("direct-1", 9000).env;
      expect(await holdAtCodexMenu(next, to, "agent-pm", "win", b.held, undefined, async () => null)).toBeNull();
    }
  });

  test("菜单一直开着：载体每次都被押回并摘掉，不留在队里、不落盘成一条普通通知，原条目不动", async () => {
    const b = rig(two(), on());
    codex(b);
    for (let k = 0; k < 3; k++) await b.stop();
    expect(b.sends).toEqual([]);
    expect((b.held.get(PM) ?? []).map((i) => [i.env.meta.messageId, i.heldAt])).toEqual([["audit-1", 1000], ["audit-2", 2000]]);
  });

  test("已有租约的重读：渲染的 await 期间才进闸（真的 createQuotaWall.gates），返回前实时核闸，内部通知不再给出，租约和原条目都在", async () => {
    const b = rig(two(), on());
    b.set({ busy: true });
    const first = await b.inbox();
    expect(first.n).toBe(2);
    const state = { v: 1, wall: {} as { exit?: unknown } };
    const wall = createQuotaWall({ load: () => state, isClaudeCode: async () => true } as never);
    let checks = 0;
    b.deps.walled = async (c) => ++checks > 1 && wall.gates(c); // 重读开头还没撞墙，渲染之后才在闸里
    await expect(b.inbox()).rejects.toThrow("保留待重读");
    expect(checks).toBe(2);
    expect((b.held.get(PM) ?? []).map((i) => [i.env.meta.messageId, i.reason, !!i.lease])).toEqual([["audit-1", "quota_wall", true], ["audit-2", "quota_wall", true]]);
    expect(b.delivered).toEqual([]);
  });

  test("队里只有同一条通知的两份：Stop 只送一次、只开一轮，两份都出队、各报一次送达；连着再 Stop 不重投", async () => {
    const a = msg("audit-same", 1000), dup = msg("audit-same", 1001);
    dup.env.meta.ts = a.env.meta.ts;
    const b = rig([a, dup], on());
    await b.stop();
    await b.stop();
    expect(b.sends.map((s) => s.id)).toEqual(["audit-same"]);
    expect(b.ids()).toEqual([]);
    expect(b.touched).toEqual(["audit-same", "audit-same"]);
  });

  test("最早一条超长又重复入队：原路径整条送一次，重复的那份随它出队，不再开第二轮", async () => {
    const a = msg("long-same", 1000), dup = msg("long-same", 1001), c = msg("audit-2", 2000);
    a.env.content = dup.env.content = "长".repeat(INBOX_MAX_CHARS);
    dup.env.meta.ts = a.env.meta.ts;
    const b = rig([a, dup, c], on());
    await b.stop();
    expect(b.sends.map((s) => s.id)).toEqual(["long-same"]);
    expect(b.ids()).toEqual(["audit-2"]);
    await b.stop();
    expect(b.sends.map((s) => s.id)).toEqual(["long-same", "audit-2"]);
  });

  test("check_inbox：同一条通知的两份只给一条、同一份租约，ack 一起出队各报一次送达；没 ack 的重读、分页读也只给一条；来源不同的同 id 仍是两条", async () => {
    const a = msg("audit-same", 1000), dup = msg("audit-same", 1001), w = msg("audit-same", 2000, "worker");
    dup.env.meta.ts = a.env.meta.ts;
    w.env.content = a.env.content;
    const b = rig([a, dup, w], on());
    b.set({ busy: true });
    const r = await b.inbox();
    expect(r.n).toBe(2);
    expect((parseInboxBatch(r.text) as { from: string; messageId: string }[]).map((e) => [e.from, e.messageId])).toEqual([["bridge:ledger-audit", "audit-same"], ["agent-worker", "audit-same"]]);
    expect(new Set((b.held.get(PM) ?? []).map((i) => i.lease?.batchId)).size).toBe(1);
    const again = await b.inbox(); // 工具结果丢了：原样重给，仍是两条
    expect(again.n).toBe(2);
    expect(parseInboxBatch(again.text)).toHaveLength(2);
    expect((await b.inbox({ ack: /inbox_[\w-]+/.exec(r.text)![0] })).text).toContain("3 条出队");
    expect(b.ids()).toEqual([]);
    expect(b.delivered).toEqual(["audit-same", "audit-same", "audit-same"]);

    const p = msg("paged-same", 1000), pdup = msg("paged-same", 1001);
    pdup.env.meta.ts = p.env.meta.ts;
    const b2 = rig([p, pdup], on());
    b2.set({ busy: true });
    expect((await b2.inbox({ read: "paged-same" })).n).toBe(1);
    expect(new Set((b2.held.get(PM) ?? []).map((i) => i.lease?.batchId)).size).toBe(1);
    expect((b2.held.get(PM) ?? []).every((i) => i.lease)).toBe(true);
    expect((await b2.inbox()).n).toBe(1); // 重读这份租约：一条
  });

  test("渲染的 await 期间当班 PM 切走（真的 setPmRoleRoute）：新领、分页读、租约重读返回前都重核归属，旧 PM 领不到、不打租约，留给当班 PM 转交", async () => {
    const route = (on: boolean) => setPmRoleRoute(() => () => (on ? { agentName: "agent-pm2", channelId: "c-pm2" } : null));
    const prev = route(false);
    try {
      const b = rig(two(), on());
      b.set({ busy: true });
      b.duringRender(() => void route(true));
      expect((await b.inbox()).n).toBe(0);
      expect((b.held.get(PM) ?? []).map((i) => i.lease)).toEqual([undefined, undefined]);
      route(false);
      await expect(b.inbox({ read: "audit-1" })).rejects.toThrow("保留待重读");
      expect((b.held.get(PM) ?? []).map((i) => i.lease)).toEqual([undefined, undefined]);
      route(false);
      b.duringRender(undefined);
      expect((await b.inbox()).n).toBe(2); // 归它时照常领
      b.duringRender(() => void route(true));
      await expect(b.inbox()).rejects.toThrow("保留待重读"); // 租约重读途中切走：不再给出
      expect(b.delivered).toEqual([]);
      expect(b.ids()).toEqual(["audit-1", "audit-2"]);
    } finally { setPmRoleRoute(prev); }
  });
});


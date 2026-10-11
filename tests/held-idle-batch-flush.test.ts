/**
 * followup-reliability-HELD1：一直忙的 PM 收不到巡检。真的 HeldQueue + flushHeld + takeInbox，投递层用一个照 bridge.ts deliverToLocal
 * 押后规则写的替身（撤下守卫 → 会话核对 → 目标在回合中就把同一封押回 → 否则送出并开一轮），不连 bridge、不读生产状态。
 * 旧路径（off / 缺省 observe）在这里是红的那几条断言：每个回合边界只送出一条、迟到的巡检一直押着、check_inbox 领不到。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, onHeldDelivered, productionIdleControl, type FlushDeps } from "../src/bridge/held-flush.js";
import { ageHeld, HELD_GIVE_UP_MS, HeldQueue, INBOX_LEASE_MS, type HeldIdleControl, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { HELD_IDLE_BATCH_ENV, heldIdleMode, isHeldIdleCarrier, isInternalIdleNotice, registryIdleScope, type HeldIdleScope, type IdleRegistryRow } from "../src/lib/held-idle-batch.js";
import { INBOX_MAX_TAKE, parseInboxBatch, parseInboxPage } from "../src/lib/inbox-batch.js";

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
  const render = async (e: Envelope) => `${e.meta.interruptNote ?? ""}${e.content}`;
  initInbox({ held, clients, calls, render, emitIn: () => {}, stoppedAt: () => undefined });
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

describe("复现：一直忙的 PM，两条早到的巡检 + 一条普通 agent 请求", () => {
  const scene = () => [msg("audit-1", 1000), msg("audit-2", 2000), msg("req-1", 3000, "worker", {}, "request")];

  test("旧路径（关）：每个回合边界只送出一条，第二条巡检被投递层押回；3 秒内又开新回合时一条都送不出，迟到的巡检一直押着、check_inbox 也领不到", async () => {
    const b = rig(scene(), undefined);
    await b.stop();
    expect(b.sends.map((s) => s.id)).toEqual(["audit-1"]); // 第一条开了新回合，第二条被押回
    expect(b.ids()).toEqual(["audit-2", "req-1"]);
    b.held.hold(PM, msg("audit-3", 4000));
    for (let k = 0; k < 4; k++) await b.stopThenNewTurn(); // 连着几个回合，Stop 后 3 秒内都已经是新回合
    expect(b.sends.map((s) => s.id)).toEqual(["audit-1"]);
    expect(b.ids()).toEqual(["audit-2", "req-1", "audit-3"]);
    const r = await b.inbox();
    expect((parseInboxBatch(r.text) as { messageId: string }[]).map((e) => e.messageId)).toEqual(["req-1"]); // 巡检不在收件箱里
    expect((b.held.get(PM) ?? []).filter((i) => i.env.from.kind === "bridge").map((i) => i.heldAt)).toEqual([2000, 4000]); // 原 heldAt 没丢
  });

  test("缺省（observe）和旧路径逐字一样：只多一行「本可一次送出」的日志", async () => {
    expect(heldIdleMode({})).toBe("observe");
    expect(heldIdleMode({ [HELD_IDLE_BATCH_ENV]: "ON " })).toBe("on");
    expect(heldIdleMode({ [HELD_IDLE_BATCH_ENV]: "yes" })).toBe("observe");
    const b = rig(scene(), productionIdleControl({}, () => rows as never));
    const lines: string[] = [], orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try { await b.stop(); } finally { console.log = orig; }
    expect(b.sends.map((s) => s.id)).toEqual(["audit-1"]);
    expect(b.ids()).toEqual(["audit-2", "req-1"]);
    expect(lines.some((l) => l.includes("只观察") && l.includes("audit-1") && l.includes("audit-2"))).toBe(true);
    const r = await b.inbox();
    expect((parseInboxBatch(r.text) as { messageId: string }[]).map((e) => e.messageId)).toEqual(["req-1"]);
  });

  test("开：下一个回合边界一次送出全部到期的内部通知，按原 heldAt 排，逐条带原 id / from / intent / thread / ts，每条各走一次送达回调；普通请求照旧等下一轮", async () => {
    const items = scene();
    const b = rig(items, on());
    const before = items.map((i) => JSON.stringify(i.env));
    await b.stop();
    expect(b.sends).toHaveLength(1);
    expect(b.sends[0].from).toBe("bridge:held-idle-batch");
    expect(originals(b.sends[0].content)).toEqual([
      { from: { kind: "bridge", label: "ledger-audit" }, message_id: "audit-1", intent: "notification", thread: "thr-audit-1", ts: items[0].env.meta.ts, heldAt: 1000 },
      { from: { kind: "bridge", label: "ledger-audit" }, message_id: "audit-2", intent: "notification", thread: "thr-audit-2", ts: items[1].env.meta.ts, heldAt: 2000 },
    ]);
    expect(b.sends[0].content).toContain("body audit-1");
    expect(b.sends[0].content).toContain("body audit-2");
    expect(b.touched).toEqual(["audit-1", "audit-2"]);
    expect(b.delivered).toEqual(["audit-1", "audit-2"]);
    expect(items.map((i) => JSON.stringify(i.env))).toEqual(before); // 原信封一个字没动
    expect(b.ids()).toEqual(["req-1"]); // 普通 agent 请求：这一轮在跑，照旧押着
    await b.stop();
    expect(b.sends.map((s) => s.id).slice(1)).toEqual(["req-1"]);
    expect(b.ids()).toEqual([]);
  });

  test("开：Stop 后 3 秒内又是新回合（Stop 的补投一条都送不出）——当前这次 check_inbox 一批领回全部到期内部通知，ack 才出队、回调各一次", async () => {
    const b = rig([...scene(), msg("ledger-1", 2500, "ledger"), msg("guest-1", 2600, "guest", {}, "request")], on());
    for (let k = 0; k < 3; k++) await b.stopThenNewTurn();
    expect(b.sends).toEqual([]);
    const r = await b.inbox();
    const got = parseInboxBatch(r.text) as { messageId: string; from: string }[];
    // 同一权限来源的内部通知一批，按原 heldAt；guest 的不混进来
    expect(got.map((e) => e.messageId)).toEqual(["audit-1", "audit-2", "ledger-1"]);
    expect(got.map((e) => e.from)).toEqual(["bridge:ledger-audit", "bridge:ledger-audit", "bridge:ledger"]);
    expect(b.delivered).toEqual([]);
    await b.stop(); // 租约内 Stop 不再投这几条（只有一个持单方）；guest 的照旧自己开一轮
    expect(b.sends.map((s) => s.id)).toEqual(["req-1"]);
    const batchId = /inbox_[\w-]+/.exec(r.text)![0];
    expect(b.delivered).toEqual(["req-1"]);
    await b.inbox({ ack: batchId });
    expect(b.delivered).toEqual(["req-1", "audit-1", "audit-2", "ledger-1"]);
    await b.inbox({ ack: batchId }); // 重复确认不重复回调
    expect(b.delivered).toHaveLength(4);
    expect(b.ids()).toEqual(["guest-1"]);
  });

  test("开：之后新到的巡检最迟下一个回合边界到，不会被新入队的挤掉", async () => {
    const b = rig(scene(), on());
    await b.stop();
    b.held.hold(PM, msg("audit-3", 6000));
    b.held.hold(PM, msg("audit-4", 7000));
    await b.stop(); // req-1 先到先投，开了一轮
    expect(b.sends.map((s) => s.id).slice(1)).toEqual(["req-1"]);
    expect(b.ids()).toEqual(["audit-3", "audit-4"]);
    await b.stop();
    expect(originals(b.sends[2].content).map((o) => o.message_id)).toEqual(["audit-3", "audit-4"]);
    expect(b.ids()).toEqual([]);
  });
});

describe("隔离：不同权限来源、人、peer、guest 仍各自分回合", () => {
  test("别的项目的 agent 通知自成一批；guest / peer / owner 的消息从不进批次；一趟只开一轮", async () => {
    const b = rig([msg("audit-1", 1000), msg("x-1", 1500, "other"), msg("audit-2", 2000), msg("x-2", 2500, "other"),
      msg("w-1", 2700, "worker"), msg("guest-1", 3000, "guest", {}, "request"), msg("peer-1", 3500, "peer", {}, "request")], on());
    await b.stop();
    expect(b.sends).toHaveLength(1);
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2", "w-1"]); // bridge + 同项目 agent
    expect(originals(b.sends[0].content)[2].from).toEqual({ kind: "local", channelId: "c-worker", agentName: "agent-worker" });
    await b.stop();
    expect(originals(b.sends[1].content).map((o) => o.message_id)).toEqual(["x-1", "x-2"]);
    await b.stop();
    await b.stop();
    expect(b.sends.slice(2).map((s) => s.id)).toEqual(["guest-1", "peer-1"]); // 各自一轮，正文是原文
    expect(b.sends.slice(2).map((s) => s.content)).toEqual(["body guest-1", "body peer-1"]);
    expect(b.sends.every((s, k) => k >= 2 || !/guest|peer/.test(s.content))).toBe(true);
  });

  test("注册表给不出证明（目标换了会话行、发送方不在册、名字对不上、不是内部来源）就没有 scope，留在原路径", () => {
    const a = msg("a", 1), w = msg("w", 2, "worker");
    const want: HeldIdleScope = { channelId: PM, agentName: "agent-pm", sessionId: "sess-1", projectId: "proj-1", ownerId: "o", permissionSource: "internal" };
    expect(registryIdleScope(a, rows, "o")).toEqual(want);
    expect(registryIdleScope(w, rows, "o")?.permissionSource).toBe("internal");
    expect(registryIdleScope(msg("x", 3, "other"), rows, "o")?.permissionSource).toBe("agent:proj-2:c-other");
    expect(registryIdleScope(a, rows.map((r) => (r.channelId === PM ? { ...r, status: "killed" } : r)), "o")).toBeUndefined();
    expect(registryIdleScope(a, rows.map((r) => (r.channelId === PM ? { ...r, sessionId: undefined } : r)), "o")).toBeUndefined();
    expect(registryIdleScope(a, [...rows, { ...rows[0], name: "agent-dup" }], "o")).toBeUndefined();
    expect(registryIdleScope(a, rows.map((r) => (r.channelId === PM ? { ...r, name: "agent-else" } : r)), "o")).toBeUndefined();
    expect(registryIdleScope(w, rows.filter((r) => r.channelId !== "c-worker"), "o")).toBeUndefined();
    expect(registryIdleScope(msg("g", 4, "guest"), rows, "o")).toBeUndefined();
  });

  test("投递层自己逐条重判的 bridge 通知（收尾提醒、续跑、fleet 群发、dropIfStopped）和载体本身不算这一类", () => {
    const lab = (label: string, over: Partial<Envelope["meta"]> = {}) => {
      const i = msg(label, 1, "audit", over);
      (i.env.from as { label: string }).label = label;
      return i;
    };
    expect(isInternalIdleNotice(lab("ledger-audit"))).toBe(true);
    for (const l of ["turn-cuts", "quota-wall", "api-error-resume", "held-idle-batch"]) expect(isInternalIdleNotice(lab(l))).toBe(false);
    expect(isInternalIdleNotice(lab("fleet", { quotaGated: true }))).toBe(false);
    expect(isInternalIdleNotice(lab("autopilot", { dropIfStopped: true }))).toBe(false);
    expect(isInternalIdleNotice(msg("req", 1, "worker", {}, "request"))).toBe(false);
  });
});

describe("原有的闸不绕：额度闸 / 压缩 / 会话更换 / 已摘下 / 竞争", () => {
  const two = () => [msg("audit-1", 1000), msg("audit-2", 2000)];

  test("额度闸、压缩中、不在线：一条不发，原条目和 heldAt 原样", async () => {
    for (const gate of [{ walled: true }, { compacting: true }, { online: false }]) {
      const b = rig(two(), on());
      b.set(gate);
      await b.stop();
      expect(b.sends).toEqual([]);
      expect((b.held.get(PM) ?? []).map((i) => [i.env.meta.messageId, i.heldAt])).toEqual([["audit-1", 1000], ["audit-2", 2000]]);
      expect(b.delivered).toEqual([]);
    }
  });

  test("核完到发送之间目标转忙：载体被投递层押回 → 摘掉，原条目一条不少、不重复、计时不变，下一个边界照常整批送", async () => {
    const b = rig(two(), on());
    b.hooks.push(() => (b.set({ busy: true }), undefined)); // deliver 的 await 里 CC 自己续跑了
    await b.stop();
    expect(b.sends).toEqual([]);
    expect((b.held.get(PM) ?? []).map((i) => [i.env.meta.messageId, i.heldAt])).toEqual([["audit-1", 1000], ["audit-2", 2000]]);
    expect((b.held.get(PM) ?? []).some(isHeldIdleCarrier)).toBe(false);
    b.hooks.length = 0;
    await b.stop();
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2"]);
  });

  test("核完到发送之间别处开了新回合（人类抢占）：守卫为假，不发也不押回", async () => {
    const b = rig(two(), on());
    b.hooks.push(() => (b.set({ turnAt: 99 }), undefined));
    await b.stop();
    expect(b.sends.filter((s) => s.from === "bridge:held-idle-batch")).toEqual([]);
    expect(b.ids()).toContain("audit-2");
    expect(b.delivered.includes("audit-2")).toBe(false);
  });

  test("投递途中其中一条被摘掉（24 小时放弃 / kill 清理）：整批不发，被摘的不复活，剩下的不丢", async () => {
    const b = rig([...two(), msg("audit-3", 3000)], on());
    b.hooks.push(() => (b.held.remove(PM, b.held.get(PM)!.find((i) => i.env.meta.messageId === "audit-2")!), undefined));
    await b.stop();
    expect(b.sends.some((s) => s.content.includes("audit-2"))).toBe(false);
    b.hooks.length = 0;
    await b.stop();
    await b.stop();
    expect(b.ids()).toEqual([]);
    expect([...b.delivered].sort()).toEqual(["audit-1", "audit-3"]);
  });

  test("目标频道换了会话：载体带着核过的 session，投递层拒掉；注册表跟上后这些通知没有丢", async () => {
    const b = rig(two(), on());
    b.set({ session: "sess-2" }); // 注册表（scope）还是 sess-1，实际已换
    await b.stop();
    expect(b.sends.filter((s) => s.from === "bridge:held-idle-batch")).toEqual([]);
    expect(b.delivered.includes("audit-2")).toBe(false);
  });

  test("投递报错 / 当班 PM 变了要重试：原条目留着，不 touch、不回调", async () => {
    for (const fail of [(e: Envelope): Delivery => ({ envelope: e, outcome: { kind: "error", error: new Error("boom") } }),
      (): never => { throw new Error("ws closed"); }]) {
      const b = rig(two(), on());
      b.hooks.push((e) => (isHeldIdleCarrier({ env: e }) ? fail(e) : undefined));
      await b.stop();
      expect(b.sends.map((s) => s.id)).toEqual(["audit-1"]); // 批次没送出：这一趟退回逐条的原路径
      expect(b.ids()).toEqual(["audit-2"]);
      expect(b.delivered).toEqual(["audit-1"]);
      expect(b.held.claim(PM)).toBe(true); // 频道锁放了
      b.held.release(PM);
    }
  });

  test("check_inbox 正领着（同一把频道锁）时 Stop 不动；领走的在租约内不进批次，过期没确认的回到下一批，message_id 不变", async () => {
    const b = rig([...two(), msg("audit-3", 3000)], on());
    b.set({ busy: true });
    expect(b.held.claim(PM)).toBe(true);
    await b.stop();
    expect(b.sends).toEqual([]);
    b.held.release(PM);
    b.set({ busy: true });
    const now = Date.now();
    const r = await b.inbox({}, now);
    expect(r.n).toBe(3);
    b.held.hold(PM, msg("audit-4", 4000));
    b.held.hold(PM, msg("audit-5", 5000));
    await b.stop();
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-4", "audit-5"]);
    for (const i of b.held.get(PM)!) i.lease!.at = now - INBOX_LEASE_MS - 1; // 工具结果丢了，一直没 ack
    await b.stop();
    expect(originals(b.sends[1].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2", "audit-3"]);
    expect(b.delivered).toEqual(["audit-4", "audit-5", "audit-1", "audit-2", "audit-3"]);
    expect((await b.inbox({ ack: /inbox_[\w-]+/.exec(r.text)![0] })).text).toContain("没有待确认的条目"); // 迟到的 ack 不再确认一遍
    expect(b.delivered).toHaveLength(5);
  });

  test("同一条通知在队里两份（重复入队）：只送一次、只开一轮，两份都出队", async () => {
    const a = msg("audit-1", 1000), dup = msg("audit-1", 1001), c = msg("audit-2", 2000);
    const b = rig([a, dup, c], on());
    await b.stop();
    expect(b.sends).toHaveLength(1);
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2"]);
    expect(b.ids()).toEqual([]);
  });

  test("24 小时放弃照旧：批次不续命也不提前丢", async () => {
    const b = rig(two(), on());
    b.set({ busy: true });
    await b.sweep();
    expect(ageHeld(b.held, 1000 + HELD_GIVE_UP_MS + 1).filter((n) => n.kind === "gave-up").map((n) => n.item.env.meta.messageId)).toEqual(["audit-1"]);
    await b.stop();
    expect(b.sends.map((s) => s.id)).toEqual(["audit-2"]); // 只剩一条：原路径整条送
  });

  test("批次开的这一轮里不塞外人：guest 的请求等它结束，再自己开一轮", async () => {
    const b = rig([...two(), msg("guest-1", 3000, "guest", {}, "request")], on());
    await b.stop();
    expect(b.sends).toHaveLength(1);
    expect(b.ids()).toEqual(["guest-1"]);
    await b.sweep(); // 这一轮还在跑：扫描也不塞
    expect(b.sends).toHaveLength(1);
    await b.stop();
    expect(b.sends[1]).toMatchObject({ id: "guest-1", content: "body guest-1" });
  });
});

describe("上限：条数 / 字数 / 超长", () => {
  test("超过一批的条数：先送最早的一批并写明还有几条，剩下的下一个回合边界到，不被新入队的饿死", async () => {
    const b = rig(Array.from({ length: INBOX_MAX_TAKE + 2 }, (_, k) => msg(`audit-${k + 1}`, 1000 + k)), on());
    await b.stop();
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(Array.from({ length: INBOX_MAX_TAKE }, (_, k) => `audit-${k + 1}`));
    expect(b.sends[0].content).toContain("另有 2 条下一个回合边界送达");
    b.held.hold(PM, msg("audit-new", 9000));
    await b.stop();
    expect(originals(b.sends[1].content).map((o) => o.message_id)).toEqual([`audit-${INBOX_MAX_TAKE + 1}`, `audit-${INBOX_MAX_TAKE + 2}`, "audit-new"]);
    expect(b.ids()).toEqual([]);
  });

  test("超长的通知：批里只给开头和分页读入口，原条目留着；check_inbox 分页读得到全文、ack 后出队；不读的话它排到最前时整条送达", async () => {
    const long = msg("audit-long", 2000);
    long.env.content = `L${"长".repeat(40_000)}END`;
    const b = rig([msg("audit-1", 1000), long, msg("audit-3", 3000)], on());
    await b.stop();
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-3", "audit-long"]);
    expect(b.sends[0].content).toContain('check_inbox({ read: "audit-long" })');
    expect(b.sends[0].content.length).toBeLessThan(16_000);
    expect(b.ids()).toEqual(["audit-long"]);
    expect(b.delivered).toEqual(["audit-1", "audit-3"]);
    // 分页读（PM 这一轮在跑）
    const p1 = await b.inbox({ read: "audit-long" });
    const page = parseInboxPage(p1.text)!;
    expect(page.pages).toBeGreaterThan(1);
    let full = page.chunk;
    for (let p = 2; p <= page.pages; p++) full += parseInboxPage((await b.inbox({ read: "audit-long", page: p })).text)!.chunk;
    expect(full.endsWith(String(long.env.content))).toBe(true);
    await b.inbox({ ack: /inbox_[\w-]+/.exec(p1.text)![0] });
    expect(b.ids()).toEqual([]);
    expect(b.delivered).toEqual(["audit-1", "audit-3", "audit-long"]);
  });

  test("最早一条自己就超长：不被后面短的跳过，原路径整条送；短的下一个边界成批", async () => {
    const long = msg("audit-long", 500);
    long.env.content = "长".repeat(40_000);
    const b = rig([long, msg("audit-1", 1000), msg("audit-2", 2000)], on());
    await b.stop();
    expect(b.sends.map((s) => [s.id, s.content.length])).toEqual([["audit-long", 40_000]]);
    await b.stop();
    expect(originals(b.sends[1].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2"]);
  });

  test("单条渲染出错：那一条留在原路径，别的照常成批，谁也不覆盖谁", async () => {
    const b = rig([msg("audit-1", 1000), msg("audit-bad", 2000), msg("audit-3", 3000)], on());
    b.deps.render = async (e) => { if (e.meta.messageId === "audit-bad") throw new Error("render"); return String(e.content); };
    await b.stop();
    expect(originals(b.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-3"]);
    expect(b.ids()).toEqual(["audit-bad"]);
    expect(b.held.get(PM)![0].heldAt).toBe(2000);
  });
});

describe("崩溃恢复（落盘的押后队列）", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "held1-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("送出之后、出队之前崩溃：盘上原条目都在，重启后整批重投，载体 message_id 和上次一样（收件方按它认重复）", async () => {
    const path = join(dir, "held.json");
    const b = rig([msg("audit-1", 1000), msg("audit-2", 2000)], on(), path);
    let snapshot = "";
    b.deps.touch = () => { snapshot ||= readFileSync(path, "utf8"); }; // 第一条 touch 时：已经 ws.send，还一条没出队
    await b.stop();
    expect(Object.values(JSON.parse(snapshot) as Record<string, HeldItem[]>)[0].map((i) => i.env.meta.messageId)).toEqual(["audit-1", "audit-2"]);
    writeFileSync(path, snapshot);
    const again = rig([], on(), path);
    expect(again.ids()).toEqual(["audit-1", "audit-2"]);
    await again.stop();
    expect(again.sends[0].id).toBe(b.sends[0].id);
    expect(originals(again.sends[0].content)).toEqual(originals(b.sends[0].content));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  test("载体被押回、还没摘就崩溃：盘上多出的那封载体恢复时不要，原条目照常；不会把整批正文当一条普通通知再投一遍", async () => {
    const path = join(dir, "held.json");
    const b = rig([msg("audit-1", 1000), msg("audit-2", 2000)], on(), path);
    let snapshot = "";
    b.hooks.push((e) => {
      b.held.holdEnv(e); // 投递层见目标在忙把载体押进队
      snapshot = readFileSync(path, "utf8");
      return { envelope: e, outcome: { kind: "sent", note: "queued" } };
    });
    await b.stop();
    expect((Object.values(JSON.parse(snapshot) as Record<string, HeldItem[]>)[0]).some(isHeldIdleCarrier)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as Record<string, HeldItem[]>)[PM].some(isHeldIdleCarrier)).toBe(false); // 正常路径当场摘掉
    writeFileSync(path, snapshot);
    const again = rig([], on(), path);
    expect(again.ids()).toEqual(["audit-1", "audit-2"]);
    await again.stop();
    expect(again.sends).toHaveLength(1);
    expect(originals(again.sends[0].content).map((o) => o.message_id)).toEqual(["audit-1", "audit-2"]);
  });
});

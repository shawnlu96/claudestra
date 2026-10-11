/**
 * followup-reliability-HELDPG1：分页读（check_inbox({ read })）给同一条内部通知的重复几份打同一份租约时只认同一权限分区。
 * 来源 / id / 正文全同但 ownerId 不同的两份：只读到的那份拿租约、ack 只出队它；同一分区内的重复照旧共用租约、一起出队。
 * 真的 HeldQueue + takeInbox，权限由注入的 HeldIdleControl 给（生产 productionIdleControl 的 ownerId 固定）。
 */
import { describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { productionIdleControl } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldIdleControl, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { HELD_IDLE_BATCH_ENV, type IdleRegistryRow } from "../src/lib/held-idle-batch.js";

const ws = { tag: "pm-ws" } as never;
const PM = "c-pm";
const to: LocalEndpoint = { kind: "local", channelId: PM, agentName: "agent-pm", ws };
const rows: IdleRegistryRow[] = [{ name: "agent-pm", status: "active", channelId: PM, sessionId: "sess-1", projectId: "proj-1" }];

/** 同一条巡检通知（来源 / id / thread / ts / 正文全同），heldAt 不同 */
function notice(id: string, heldAt: number): HeldItem {
  const env = {
    from: { kind: "bridge", label: "ledger-audit" }, to, intent: "notification", content: `body ${id}`,
    meta: { messageId: id, threadId: `thr-${id}`, ts: "2026-10-11T00:00:00Z", triggerKind: "bridge_synth", waitForIdle: true },
  } as Envelope;
  return { env, to, heldAt };
}

/** ownerOf 给每条指定 ownerId（不同 = 不同权限分区） */
function rig(items: HeldItem[], ownerOf: (i: HeldItem) => string) {
  const base = productionIdleControl({ [HELD_IDLE_BATCH_ENV]: "on" }, () => rows as never);
  const control: HeldIdleControl = {
    ...base,
    scope: (i) => { const s = base.scope(i); return s && { ...s, ownerId: ownerOf(i) }; },
  };
  const held = new HeldQueue(null, control);
  for (const i of items) held.hold(PM, i);
  initInbox({ held, clients: new Map([[PM, { ws }]]), calls: new AgentCallBook(null), render: async (e) => String(e.content),
    emitIn: () => {}, stoppedAt: () => undefined, walled: async () => false });
  const inbox = async (opts: Parameters<typeof takeInbox>[2] = {}) => {
    const r = await takeInbox(ws, Date.now(), opts);
    if ("error" in r) throw new Error(r.error);
    return r.result;
  };
  return { held, inbox, queued: () => held.get(PM) ?? [] };
}
const batchOf = (text: string) => /inbox_[\w-]+/.exec(text)![0];

describe("分页读的重复条目按权限分区", () => {
  test("来源 / id / 正文相同、ownerId 不同的两份：分页读一份只给它租约，ack 只出队它，另一份留在队里没租约", async () => {
    const a = notice("audit-same", 1000), b = notice("audit-same", 1001);
    const r = rig([a, b], (i) => (i === a ? "owner-1" : "owner-2"));
    const p = await r.inbox({ read: "audit-same" });
    expect(p.n).toBe(1);
    expect(a.lease?.batchId).toBe(batchOf(p.text));
    expect(b.lease).toBeUndefined();
    const next = await r.inbox({ ack: batchOf(p.text) }); // ack 顺带领下一批：b 按自己的分区另开一份租约
    expect(next.text).toContain("1 条出队");
    expect(r.queued()).toEqual([b]);
    expect(b.lease?.batchId).not.toBe(batchOf(p.text));
  });

  test("同一分区内的重复：分页读后共用同一份租约，ack 一起出队", async () => {
    const a = notice("audit-same", 1000), b = notice("audit-same", 1001);
    const r = rig([a, b], () => "owner-1");
    const p = await r.inbox({ read: "audit-same" });
    expect(p.n).toBe(1);
    expect(a.lease?.batchId).toBe(batchOf(p.text));
    expect(b.lease?.batchId).toBe(batchOf(p.text));
    await r.inbox({ ack: batchOf(p.text) });
    expect(r.queued()).toEqual([]);
  });

  test("三份里两份同分区、一份另一分区：只有同分区的那份跟着租约、跟着出队", async () => {
    const a = notice("audit-same", 1000), b = notice("audit-same", 1001), c = notice("audit-same", 1002);
    const r = rig([a, b, c], (i) => (i === b ? "owner-2" : "owner-1"));
    const p = await r.inbox({ read: "audit-same" });
    expect(c.lease?.batchId).toBe(batchOf(p.text));
    expect(b.lease).toBeUndefined();
    await r.inbox({ ack: batchOf(p.text) });
    expect(r.queued()).toEqual([b]);
  });

  test("同分区重复、读到的那份经退回排在队首但 heldAt 更晚：仍共用租约、ack 一起出队", async () => {
    const a = notice("audit-same", 1001), b = notice("audit-same", 1000);
    const r = rig([b], () => "owner-1");
    r.held.idleCarrierSent(a.env, [a]); // a 作为批次载体送出后被退回：holdFirst 把它放回队首 → [a, b]
    r.held.holdFirst(a.env);
    expect(r.queued()).toEqual([a, b]);
    const p = await r.inbox({ read: "audit-same" });
    expect(a.lease?.batchId).toBe(batchOf(p.text));
    expect(b.lease?.batchId).toBe(batchOf(p.text));
    await r.inbox({ ack: batchOf(p.text) });
    expect(r.queued()).toEqual([]);
  });
});

/**
 * i28-M11：owner 本人消息和卡片答复押满 OWNER_HELD_MAX_MS，下一次扫描直接投——不等画面静止、不看这一轮是谁开的、排在外人前面；
 * 压缩中、check_inbox 租约内仍不投；peer / guest 和 fleet 群发的投递条件不变。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { clearOpenedBy, flushHeld, OWNER_HELD_MAX_MS, ownerLate, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { isHumanRequest, type Delivery, type Envelope, type LocalEndpoint } from "../src/bridge/router.js";

beforeEach(() => clearOpenedBy());

const ws = { tag: "target-ws" } as never;
const T0 = 1_790_000_000_000;
const OWNER_API: Envelope["from"] = { kind: "api", tokenId: "owner:self", name: "owner", owner: true };
const OWNER_DISCORD: Envelope["from"] = { kind: "user", userId: "u1", channelId: "c-me", username: "owner" };
const PEER: Envelope["from"] = { kind: "api", tokenId: "tok-p", name: "He", peer: "He" };
const to = { kind: "local", agentName: "agent-me", channelId: "c-me", ws } as LocalEndpoint;

function mk(content: string, from: Envelope["from"], meta: Partial<Envelope["meta"]> = {}, intent: Envelope["intent"] = "request", heldAt = T0): HeldItem {
  const env = { from, to, intent, content, meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-10-01T00:00:00Z", threadId: `thr-${content}`, ...meta } } as Envelope;
  return { env, to, heldAt };
}
/** 卡片答复（asks.ts sendCalm）：response、带 waitForIdle */
const ask = (content = "ask", heldAt = T0) => mk(content, OWNER_API, { triggerKind: "ask_answer", waitForIdle: true, askId: "ask_1" }, "response", heldAt);
const fleet = () => mk("fleet", OWNER_API, { triggerKind: "bridge_synth", waitForIdle: true, quotaGated: true });
const sent = (env: Envelope, note?: string): Delivery => ({ envelope: env, outcome: { kind: "sent", ...(note ? { note } : {}) } });

/**
 * deliver 学真 deliverToLocal 的两条：isHumanRequest 才抢占（记下来）；带 waitForIdle 的目标忙时押回（queued）
 */
function harness(items: HeldItem[], over: Partial<FlushDeps> & { busy?: () => boolean } = {}) {
  const held = new HeldQueue(null);
  held.set("c-me", items);
  const delivered: string[] = [];
  const preempted: string[] = [];
  let clock = T0;
  const busy = over.busy ?? (() => false);
  const deps: FlushDeps = {
    held,
    compacting: () => false,
    working: async () => busy(),
    isHumanRequest,
    client: () => ({ ws }),
    deliver: async (env) => {
      if (env.meta.waitForIdle && busy()) return sent(env, "queued");
      if (isHumanRequest(env)) preempted.push(String(env.content));
      delivered.push(String(env.content));
      return sent(env);
    },
    touch: () => {},
    settled: async () => false, // 画面一直在变（一直有后台任务在出字的 PM）
    turnAt: () => 7,
    now: () => clock,
    ...over,
  };
  return {
    held, deps, delivered, preempted,
    at: (ms: number) => void (clock = T0 + ms),
    contents: () => (held.get("c-me") ?? []).map((i) => String(i.env.content)),
  };
}

describe("ownerLate", () => {
  test("卡片答复、不带 waitForIdle 的 owner 消息押满时限才算；fleet 群发、peer、agent 永远不算", () => {
    const late = T0 + OWNER_HELD_MAX_MS;
    expect(ownerLate(ask(), late - 1)).toBe(false);
    expect(ownerLate(ask(), late)).toBe(true);
    expect(ownerLate(mk("o", OWNER_DISCORD), late)).toBe(true);
    expect(ownerLate(mk("o", OWNER_API), late)).toBe(true);
    expect(ownerLate(fleet(), late * 2)).toBe(false);
    expect(ownerLate(mk("p", PEER), late * 2)).toBe(false);
    expect(ownerLate(mk("a", { kind: "local", agentName: "agent-x", channelId: "c-x", ws }), late * 2)).toBe(false);
  });
});

describe("flushHeld：owner 答复押满时限", () => {
  test("目标一直忙：卡片答复不到 2 分钟照旧押着；押满后下一次扫描投出去，不抢占、不被 deliverToLocal 押回", async () => {
    const h = harness([ask()], { busy: () => true });
    h.at(OWNER_HELD_MAX_MS - 1);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual([]);
    expect(h.contents()).toEqual(["ask"]);
    h.at(OWNER_HELD_MAX_MS);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["ask"]);
    expect(h.preempted).toEqual([]);
    expect(h.contents()).toEqual([]);
  });

  test("这一轮是 peer 补投开的：owner 的 request 不到时限等它结束，押满后照投（抢占语义不变）", async () => {
    let working = false;
    const h = harness([mk("peer", PEER), mk("owner", OWNER_DISCORD, {}, "request", T0 + 1)], { working: async () => working, settled: async () => true });
    await flushHeld(h.deps, "c-me", "stop"); // 空闲：peer 先到先开一轮
    expect(h.delivered).toEqual(["peer"]);
    working = true;
    h.at(OWNER_HELD_MAX_MS);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["peer"]);
    h.at(OWNER_HELD_MAX_MS + 1);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["peer", "owner"]);
    expect(h.preempted).toEqual(["owner"]);
  });

  test("判成空闲但画面一直在变：押满的卡片答复越过前面等画面的 peer 先投；peer 押多久都还是等画面静下来", async () => {
    const h = harness([mk("peer", PEER, {}, "request", T0 - 3_600_000), ask()]);
    h.at(OWNER_HELD_MAX_MS - 1);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual([]); // 卡片答复是 owner 的：空闲时本来就不看画面，但排在 peer 后面被它挡住
    h.at(OWNER_HELD_MAX_MS);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["ask"]);
    expect(h.contents()).toEqual(["peer"]);
    h.at(24 * 3_600_000);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual(["peer"]);
  });

  test("目标忙时 peer、guest、agent 和 fleet 群发押多久都不投（外人条件不放宽）", async () => {
    const guest = mk("guest", { kind: "api", tokenId: "tok-g", name: "guest" });
    const agent = mk("agent", { kind: "local", agentName: "agent-x", channelId: "c-x", ws }, {}, "request");
    const h = harness([mk("peer", PEER), guest, agent, fleet()], { busy: () => true, settled: async () => true });
    h.at(24 * 3_600_000 - 1);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual([]);
    expect(h.contents()).toEqual(["peer", "guest", "agent", "fleet"]);
  });

  test("压缩中不投；check_inbox 租约内不投，租约过期后照投", async () => {
    let compacting = true;
    const leased = { ...ask("leased"), lease: { batchId: "inbox_x", at: Date.now() } };
    const h = harness([ask(), leased], { busy: () => true, compacting: () => compacting });
    h.at(OWNER_HELD_MAX_MS * 10);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual([]);
    compacting = false;
    await flushHeld(h.deps, "c-me", "compact_end");
    expect(h.delivered).toEqual(["ask"]);
    expect(h.contents()).toEqual(["leased"]);
  });

  test("额度闸里、目标忙：押满的卡片答复照投（能穿闸），fleet 群发仍押着", async () => {
    const h = harness([fleet(), ask()], { busy: () => true, walled: async () => true });
    h.at(OWNER_HELD_MAX_MS);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["ask"]);
    expect(h.contents()).toEqual(["fleet"]);
  });

  test("投出去又被押回（queued）：原条目留着、heldAt 不变，下一次扫描再投", async () => {
    let back = true;
    const h = harness([ask()], { busy: () => true });
    const deliver = h.deps.deliver;
    h.deps.deliver = async (env, t, w) => (back ? ((back = false), sent(env, "queued")) : deliver(env, t, w));
    h.at(OWNER_HELD_MAX_MS);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual(["ask"]);
    expect(h.held.get("c-me")![0].heldAt).toBe(T0);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["ask"]);
  });
});

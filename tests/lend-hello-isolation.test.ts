/**
 * i28-W3 r1 修复的回归（src/lib/lend-hello.ts、src/lib/lend-loop.ts）：
 * - hello 的授权在发前现读：本轮开头读完 lend.json 之后、在 context / peers 的 await 期间收回，发出去的也必须是 grant:null；
 * - 各 peer 并发：排在前面的 peer 的 hello 挂满 15 秒，team-a 的 claim、beat 仍在这一轮开头发出（审查员探针的形状）；
 * - helloMs 夹到 ≤60 秒：A 回 120 秒也按 60 秒保活，降级 ≤60 秒内发现；hello / beat 回 403 messages_only 同 404：proto 1、当轮逐单续租并补 poll。
 * A 是假的，时钟手拨（tests/lend-harness.ts）；「挂着」用一个没兑现的 promise 表示，不真等 15 秒。
 */
import { describe, expect, test } from "bun:test";
import { workerName } from "../src/lib/lend-drive.js";
import { peerProto } from "../src/lib/lend-hello.js";
import { advance, localDay, recordAsked } from "../src/lib/lend-journal.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

type H = ReturnType<typeof harness>;
type Reply = { status: number; body: unknown };
const helloOk = (helloMs = 60_000): Reply => ({ status: 200, body: { ok: true, v: 1, proto: 2, helloMs, beatMs: 15_000 } });
const beatOk = (b: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, v: 1, orders: (b.orders as { orderId: string; gen: number }[])
  .map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: o.gen, expiresAt: 0, ms: 600_000 } })) } });

/** 接上 v2：每个 peer 的 hello / beat 应答可换，发出去的正文与时刻都记下 */
function withV2(h: H) {
  const A2 = { hello: (_p: string): Reply | Promise<Reply> => helloOk(), beat: (_p: string, b: Record<string, unknown>): Reply | Promise<Reply> => beatOk(b) };
  const sent: { peer: string; op: "hello" | "beat"; body: Record<string, unknown>; at: number }[] = [];
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  h.d.v2 = { boot: "boot-iso-0001", call: async (peer, op, body) => {
    sent.push({ peer, op, body, at: h.d.now() });
    return op === "hello" ? A2.hello(peer) : A2.beat(peer, body);
  } };
  return { A2, sent, hellos: (peer = "team-a") => sent.filter((s) => s.op === "hello" && s.peer === peer).map((s) => s.body) };
}

function started(h: H, id: string) {
  const now = h.d.now();
  recordAsked(h.db, { orderId: id, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(id) } }, now);
  advance(h.db, id, "asked", "claimed", { wire: { order: wire(id), text: TEXT }, day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, id, "claimed", "cloned", { dir: `/lend/work/${id}` }, now);
  h.registry.set(workerName(id), { sessionId: `s-${id}`, cwd: `/lend/work/${id}` });
  advance(h.db, id, "cloned", "started", { agent: workerName(id), sessionId: `s-${id}`, startedAt: now, submit: "sent", notices: { start: now } }, now);
}

describe("hello 的授权发前现读", () => {
  test("读完 lend.json 之后、context 的 await 期间收回：hello 正文是 grant:null", async () => {
    const h = harness();
    const v = withV2(h);
    const ctx = h.d.context;
    h.d.context = async () => { h.lend.enabled = false; return ctx(); };
    await h.tick();
    expect(v.hellos()).toHaveLength(1);
    expect(v.hellos()[0].grant).toBeNull();
    expect(v.hellos()[0].slots).toEqual({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } });
  });

  test("peers 的 await 期间删掉这条授权：同样 grant:null；之前已告诉过 A 的授权当轮收回", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    expect(v.hellos()[0].grant).not.toBeNull();
    const peers = h.d.peers;
    h.d.peers = async () => { h.lend.lend = []; return peers(); };
    h.advanceTime(1_000);
    await h.tick();
    expect(v.hellos().map((b) => b.grant === null)).toEqual([false, true]);
  });
});

describe("一个 peer 慢不拖别的 peer", () => {
  test("slow 排在 team-a 前、hello 挂满 15 秒：team-a 的 claim 与 beat 都在本轮开头发出，不等 slow；lendTick 不抛", async () => {
    const h = harness();
    h.lend.lend.unshift({ ...h.lend.lend[0], peer: "slow" });
    h.d.context = async () => ({ contacts: [{ name: "slow", fp: FP }, { name: "team-a", fp: FP }], projects: [] });
    const peers = h.d.peers;
    h.d.peers = async () => [{ ...(await peers())[0], name: "slow" } as HttpPeer, ...(await peers())];
    const v = withV2(h);
    let release = () => {};
    const freed = new Promise<void>((res) => { release = res; });
    v.A2.hello = async (peer) => {
      if (peer !== "slow") return helloOk();
      await Promise.race([freed, Bun.sleep(300)]); // 串行实现会在这里等满，再把时钟拨过 15 秒
      h.advanceTime(15_000);
      throw new Error("超时");
    };
    const at: Record<string, number> = {};
    const v1 = h.d.call;
    h.d.call = async (peer, op, body) => {
      if (peer === "team-a") at[op] ??= h.d.now();
      if (op === "claim") release();
      return v1(peer, op, body);
    };
    started(h, "s1");
    recordAsked(h.db, { orderId: "a1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("a1"), source: "push" } });
    const t0 = h.d.now();
    await h.tick();
    expect(at.claim).toBe(t0);
    expect(v.sent.find((s) => s.peer === "team-a" && s.op === "beat")?.at).toBe(t0);
    expect(v.sent.filter((s) => s.peer === "slow").map((s) => s.op)).toEqual(["hello"]); // 失败一次之后本轮对 slow 什么都不再发
  });
});

describe("降级 ≤60 秒内发现", () => {
  test("A 回 helloMs=120 秒也按 60 秒保活：之后 A 降级（404），60 秒时的 hello 就发现、记 proto 1", async () => {
    const h = harness();
    const v = withV2(h);
    v.A2.hello = () => helloOk(120_000);
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
    v.A2.hello = () => ({ status: 404, body: null });
    h.advanceTime(59_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(1);
    h.advanceTime(1_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(2);
    expect(peerProto(h.db, "team-a")).toBe(1);
  });

  test("beat 回 403 messages_only：同 404，记 proto 1，当轮就逐单续租、补一次 poll", async () => {
    const h = harness();
    const v = withV2(h);
    v.A2.hello = () => helloOk(120_000);
    started(h, "o1");
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
    v.A2.beat = () => ({ status: 403, body: { ok: false, code: "messages_only", error: "只能投递消息" } });
    h.advanceTime(61_000);
    const before = h.calls.length;
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(1);
    const ops = h.calls.slice(before).map((c) => (c.op === "lease" ? `lease:${c.body.action}` : c.op));
    expect(ops).toContain("lease:renew");
    expect(ops).toContain("poll");
  });

  test("hello 回 403 messages_only：同 404，记 proto 1、隔 60 秒再问；其他 4xx 仍只退避，不改协议", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    v.A2.hello = () => ({ status: 403, body: { ok: false, code: "messages_only", error: "只能投递消息" } });
    h.advanceTime(61_000);
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(1);
    h.advanceTime(30_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(2);
    v.A2.hello = () => helloOk();
    h.advanceTime(30_000);
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
    v.A2.hello = () => ({ status: 403, body: { ok: false, code: "forbidden", error: "不许" } });
    h.advanceTime(61_000);
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
  });
});

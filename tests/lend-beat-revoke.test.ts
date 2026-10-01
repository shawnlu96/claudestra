/**
 * i28-W3 收回即停、出站不卡（src/lib/lend-loop.ts 的轮次顺序 + lend-beat.ts 的 ended）：
 * - 收回后在跑的单先 kill 并确认，之后才有任何出站（注入挂到超时的传输验）；
 * - proto 2 的 A 不收 v1 release stopped，改在 beat 里带 ended{revoked, clean}；clean 只给 kill 已确认的审查单 / 从没推送过的写单；
 *   A 回了这一行就清通知标记，本地租约过了还没送到也清（记日志）；claimed / cloned 照旧 v1 not_started，proto 1 照旧 v1 stopped；
 * - 一个 peer 的 hello / beat 一直超时不拖另一个 peer；被跳过的结束通知不算发过；lendTick 不抛（SchedulerStopped 除外）。
 */
import { describe, expect, test } from "bun:test";
import { workerName } from "../src/lib/lend-drive.js";
import { advance, getOrder, localDay, patchOrder, recordAsked, setMeta, type LendRow } from "../src/lib/lend-journal.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

type Line = { orderId: string; gen: number; ended?: { reason: string; clean: boolean } };

/** v2 接上；events 按发生顺序记 kill 与每一次出站（v1、v2 都记） */
function rig(h: ReturnType<typeof harness>, opts: { hang?: (peer: string) => boolean } = {}) {
  const s = { events: [] as string[], beats: [] as Line[][], beatAnswer: (lines: Line[]) => lines.map((o) => ({ orderId: o.orderId, verdict: "ok",
    lease: o.ended ? null : { gen: o.gen, expiresAt: 0, ms: 600_000 } })) };
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  const v1 = h.d.call;
  const hang = async (peer: string) => {
    if (!opts.hang?.(peer)) return;
    h.advanceTime(15_000); // 挂满单次出站上限才断
    throw new Error("超时");
  };
  h.d.call = async (peer, op, body) => { s.events.push(`call:${op}:${peer}`); await hang(peer); return v1(peer, op, body); };
  const kill = h.d.worker.kill;
  h.d.worker.kill = async (n) => { s.events.push(`kill:${n}`); return kill(n); };
  h.d.v2 = { boot: "boot-revk-0001", call: async (peer, op, body) => {
    s.events.push(`call:${op}:${peer}`);
    await hang(peer);
    if (op === "hello") return { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };
    s.beats.push(body.orders as Line[]);
    return { status: 200, body: { ok: true, v: 1, orders: s.beatAnswer(body.orders as Line[]) } };
  } };
  return s;
}

function started(h: ReturnType<typeof harness>, id: string, step = "review", peer = "team-a"): LendRow {
  const now = h.d.now();
  recordAsked(h.db, { orderId: id, peer, fp: FP, family: "codex", preview: { ...polled(id), step } }, now);
  advance(h.db, id, "asked", "claimed", { wire: { order: { ...wire(id), step }, text: TEXT }, day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, id, "claimed", "cloned", { dir: `/lend/work/${id}` }, now);
  h.registry.set(workerName(id), { sessionId: `s-${id}`, cwd: `/lend/work/${id}` });
  return advance(h.db, id, "cloned", "started", { agent: workerName(id), sessionId: `s-${id}`, startedAt: now, submit: "sent", notices: { start: now } }, now);
}

const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release").map((c) => `${c.body.orderId}:${c.body.reason}`);
const endedLines = (s: ReturnType<typeof rig>) => s.beats.flat().filter((l) => l.ended).map((l) => `${l.orderId}:${l.ended!.clean}`);

describe("收回之后先停、后出站", () => {
  test("传输挂到超时：同一轮里所有授权失效的 worker 都先 kill 并确认，第一个出站请求排在它们后面", async () => {
    const h = harness();
    const s = rig(h, { hang: () => true });
    started(h, "o1");
    started(h, "o2");
    h.lend.lend = [];
    await h.tick();
    const firstCall = s.events.findIndex((e) => e.startsWith("call:"));
    const kills = s.events.map((e, i) => (e.startsWith("kill:") ? i : -1)).filter((i) => i >= 0);
    expect(kills.length).toBe(2);
    expect(firstCall === -1 || Math.max(...kills) < firstCall).toBe(true);
    expect([getOrder(h.db, "o1")!.state, getOrder(h.db, "o2")!.state]).toEqual(["stopped", "stopped"]);
  });
});

describe("proto 2：收回在 beat 里报 ended", () => {
  test("审查单：kill 确认后 beat 带 ended{revoked, clean:true}，不发 v1 release；A 回了这一行就清标记、收尾照做", async () => {
    const h = harness();
    const s = rig(h);
    started(h, "o1");
    await h.tick(); // hello → proto 2
    h.lend.lend = [];
    h.advanceTime(16_000);
    await h.tick();
    expect(endedLines(s)).toEqual(["o1:true"]);
    expect(releases(h)).toEqual([]);
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("stopped");
    expect(row.settle).toBeNull(); // 通知标记清了，删目录 / 收据 / 停止通知随后做完
    expect(h.log.receipts.map((r) => r.orderId)).toEqual(["o1"]);
  });

  test("写单交过 work（可能已推送）→ clean:false；审查单没确认退出 → 这一轮不报，确认之后才报", async () => {
    const h = harness({ writeOpen: true, entry: { roles: ["review", "write"] } });
    const s = rig(h);
    started(h, "w1", "write");
    patchOrder(h.db, "w1", ["started"], { work: { head: "f".repeat(40), summary: "s", selfCheck: "c" } });
    started(h, "r1");
    await h.tick();
    const kill = h.d.worker.kill;
    let refuse = true;
    h.d.worker.kill = async (n) => (n === workerName("r1") && refuse ? { ok: false, reason: "窗口还在" } : kill(n));
    h.lend.lend = [];
    h.advanceTime(16_000);
    await h.tick();
    expect(endedLines(s)).toEqual(["w1:false"]);
    expect(getOrder(h.db, "r1")!.state).toBe("started");
    refuse = false;
    h.advanceTime(16_000);
    await h.tick();
    expect(endedLines(s)).toEqual(["w1:false", "r1:true"]);
  });

  test("本地租约截止过了还没送到：清标记、记日志，不再报", async () => {
    const h = harness();
    const s = rig(h);
    started(h, "o1");
    await h.tick();
    h.lend.lend = [];
    s.beatAnswer = () => { throw new Error("A 那边 500"); };
    h.advanceTime(16_000);
    await h.tick();
    expect(getOrder(h.db, "o1")!.settle?.notify).toBe("stopped");
    h.advanceTime(700_000);
    await h.tick();
    expect(getOrder(h.db, "o1")!.settle?.notify ?? null).toBeNull();
    expect(h.log.lines.some((l) => l.includes("本地租约截止前没送到"))).toBe(true);
    expect(releases(h)).toEqual([]);
  });

  test("claimed / cloned 阶段被收回：照旧 v1 not_started", async () => {
    const h = harness();
    rig(h);
    started(h, "o1");
    await h.tick();
    recordAsked(h.db, { orderId: "o2", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("o2") } });
    advance(h.db, "o2", "asked", "claimed", { wire: { order: wire("o2"), text: TEXT }, leaseGen: 1, leaseUntil: h.d.now() + 600_000, lastBeatAt: h.d.now() });
    h.lend.lend = [];
    h.advanceTime(16_000);
    await h.tick();
    expect(releases(h)).toEqual(["o2:not_started"]);
  });

  test("proto 1 的 A（hello 404）：照旧 v1 release stopped，不带 ended", async () => {
    const h = harness();
    const s = rig(h);
    const v2call = h.d.v2!.call;
    h.d.v2!.call = async (peer, op, body) => (op === "hello" ? { status: 404, body: null } : v2call(peer, op, body));
    started(h, "o1");
    await h.tick();
    h.lend.lend = [];
    h.advanceTime(16_000);
    await h.tick();
    expect(releases(h)).toEqual(["o1:stopped"]);
    expect(endedLines(s)).toEqual([]);
  });
});

describe("一个 peer 出问题不拖别人", () => {
  test("team-b 的 hello / beat 一直超时：team-a 的单照样 claim、续租；lendTick 不抛", async () => {
    const h = harness();
    const s = rig(h, { hang: (peer) => peer === "team-b" });
    h.lend.lend.push({ ...h.lend.lend[0], peer: "team-b" });
    h.d.context = async () => ({ contacts: [{ name: "team-a", fp: FP }, { name: "team-b", fp: FP }], projects: [] });
    const peers = h.d.peers;
    h.d.peers = async () => [...(await peers()), { ...(await peers())[0], name: "team-b" } as HttpPeer];
    started(h, "b1", "review", "team-b");
    recordAsked(h.db, { orderId: "a1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("a1"), source: "push" } });
    await h.tick();
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["a1"]);
    expect(s.events.filter((e) => e.endsWith(":team-b"))).toEqual(["call:hello:team-b"]); // 失败一次之后本轮对 team-b 什么都不再发
    h.advanceTime(16_000);
    await h.tick();
    expect(s.beats.flat().map((l) => l.orderId)).toContain("a1");
  });

  test("被跳过的结束通知不算发过：这一轮 A 不通（第一个出站就超时），下一轮通了才发、只发一次", async () => {
    const h = harness();
    let down = true;
    rig(h, { hang: () => down });
    started(h, "o1");
    advance(h.db, "o1", "started", "stopped", { reason: "worker 掉了", settle: { notify: "stopped", removeDir: false } });
    await h.tick();
    expect(getOrder(h.db, "o1")!.settle?.notify).toBe("stopped");
    expect(releases(h)).toEqual([]);
    down = false;
    h.advanceTime(70_000);
    await h.tick();
    await h.tick();
    expect(releases(h)).toEqual(["o1:stopped"]);
  });

  test("hello / beat 状态读坏了（meta 里不是 JSON）：当没有，hello 重发、beat 照发，lendTick 不抛，别的照跑", async () => {
    const h = harness();
    const s = rig(h);
    started(h, "o1");
    setMeta(h.db, "hello:team-a", "{坏");
    setMeta(h.db, "beat:team-a", "{坏");
    setMeta(h.db, "lastPoll:team-a", "{坏");
    recordAsked(h.db, { orderId: "a1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("a1") } });
    await h.tick();
    expect(s.events.filter((e) => e.startsWith("call:hello") || e.startsWith("call:beat"))).toEqual(["call:hello:team-a", "call:beat:team-a"]);
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["a1"]);
  });
});

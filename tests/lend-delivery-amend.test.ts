/**
 * i28-RPX1：出借修复单交付说明缺『复现测试：』时不停单。A 侧回 delivery_note（别的 invalid 照旧）；B 侧把拒收原因发回原 worker、
 * 按同一 head / 同一租约重交，最多补 2 次；发出前先自查 acceptance；旧版 B 遇到新码照旧 stopped、不抛。
 * A 用本机台账夹具（不连 peer），B 用假 peer A、假 worker 会话；journal 在内存、工作副本在临时目录，不碰 ~/.claude-orchestrator。
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, resultDeps } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { FIX_STRATEGY_RULE } from "../src/lib/fix-strategy.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendDeliver } from "../src/lib/ledger-lend-result.js";
import { LedgerError } from "../src/lib/ledger-store.js";
import { workerName } from "../src/lib/lend-drive.js";
import { DELIVERY_NOTE, DELIVERY_NOTE_STATUS } from "../src/lib/lend-delivery-amend-code.js";
import { amendState, NOTE_FILE } from "../src/lib/lend-delivery-amend.js";
import type { LendEntry } from "../src/lib/lend-config.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance, getOrder, openLendJournal } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import { lendRequest, type LendOp } from "../src/lib/lend-remote.js";
import type { DeliverRequest } from "../src/lib/lend-wire.js";
import type { HttpPeer } from "../src/lib/peers.js";

// ── A 侧（本机台账）──

/** A 收一份修复交付，拒了就返回 wire 码（bridge 取 current.lend，没有就 LedgerError 的 code） */
async function aDeliver(summary: string, remoteHead?: string) {
  const f = await fourRoundFix();
  const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
  await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
  const o = remoteOrder(f.db, intent.id)!;
  claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker: workerName(o.orderId) }, () => p.context.borrow[0]);
  const head = "5".repeat(40), req: DeliverRequest = { v: 1, orderId: o.orderId, gen: 1, branch: "feat/T1", pr: 7,
    session: { id: "peer-session", family: "codex" }, deliver: { v: 1, orderId: o.orderId, head, evidence: "report.md", summary, selfCheck: "先红后绿" } };
  const deps = { ...resultDeps, peerFp: async () => "abcd-bbbb-cccc-dddd", remoteHead: async () => ({ ok: true as const, head: remoteHead ?? head }) };
  try {
    return { receipt: await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "body", deps), stage: f.task().stage };
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    return { code: (e.current?.lend ?? e.code) as string, missing: e.current?.missing, stage: f.task().stage };
  } finally { f.close(); }
}

describe("A 侧：区分『说明不全』与『结论无效』", () => {
  test("修复交付缺『复现测试：』→ delivery_note（带缺的那一项），卡不动；补上就收", async () => {
    const r = await aDeliver("修好了 race，先红后绿");
    expect(r).toMatchObject({ code: DELIVERY_NOTE, missing: "复现测试", stage: "fix" });
    expect(DELIVERY_NOTE_STATUS[DELIVERY_NOTE]).toBe(400); // bridge 映射成 4xx：对方读得到 code
    expect(await aDeliver("复现测试：remote-race，先红后绿")).toMatchObject({ receipt: { sha256: "body" }, stage: "review" });
  });

  test("其他 invalid（远端 head 对不上）照旧回 invalid", async () => {
    expect(await aDeliver("修好了 race", "6".repeat(40))).toMatchObject({ code: "invalid", stage: "fix" });
    expect(await aDeliver("复现测试：remote-race", "6".repeat(40))).toMatchObject({ code: "invalid", stage: "fix" });
  });
});

// ── B 侧（lend 循环，假 peer A、假 worker）──

const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const FP = "abcd-ef01-2345-6789";
const WB = lendBranch("T93", FP)!;
const REPO = "shawnlu96/claudestra";
const TEXT = "【出借派单】T93 · fix";
const T0 = 1_000_000;
const ENTRY: LendEntry = { peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review", "write"], repos: [REPO], ordersPerDay: 5,
  grantedAt: new Date(T0).toISOString(), until: new Date(T0 + 6 * 86_400_000).toISOString() };
const PEER = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const polled = { orderId: "w1", taskId: "T93", step: "fix", family: "codex", repo: REPO, pr: 7, head: BASE, round: 2, specRev: 1, offeredAt: 1 };
const NOTE_OK = "修好了 race；复现测试：t-race，先红后绿";

type AReply = { code: string } | "ok";

/** peer A 对 result 的应答按 replies 依次给（用完 = 收下）；worker 收到补写指令就按 notes 依次把摘要写进工作副本（用完 = 不写） */
function harness(o: { acceptance?: string[]; replies?: AReply[]; notes?: string[] } = {}) {
  const db = openLendJournal(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "lend-amend-"));
  const calls: { op: LendOp; body: Record<string, unknown> }[] = [];
  const sent: string[] = [];
  const pushed: string[] = [];
  const replies = [...(o.replies ?? [])];
  const notes = [...(o.notes ?? [])];
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const clock = { t: T0 };
  const lease = { refuse: null as string | null };
  const wire = { v: 1, orderId: "w1", taskId: "T93", specRev: 1, dagVersion: null, node: "fix", step: "fix", round: 2, head: BASE, repo: REPO, pr: 7,
    inputs: ["规格原文"], outputs: ["提交"], acceptance: o.acceptance ?? ["只推订单分支"], writeBack: "lend submit", findings: [], fallback: null };
  const d: LoopDeps = {
    db, now: () => clock.t, env: {}, footer: () => "（本机尾注）", log: () => {},
    failure: () => undefined, closeAsks: async () => ({ ok: true }), codexQuota: async () => null,
    call: async (_p, op, body) => {
      calls.push({ op, body });
      if (op === "poll") return { status: 200, body: { ok: true, v: 1, orders: [polled], pollAfterMs: 30_000 } };
      if (op === "claim") return { status: 200, body: { ok: true, v: 1, order: wire, text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 },
        write: { branch: WB, base: "main" } } };
      if (op === "lease" && body.action === "renew" && lease.refuse) return { status: 409, body: { ok: false, code: lease.refuse, error: lease.refuse } };
      if (op === "lease") return { status: 200, body: { ok: true, v: 1, lease: body.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } };
      const r = replies.shift() ?? "ok";
      if (r !== "ok") return { status: 400, body: { ok: false, code: r.code, error: `${r.code}：换会话修复交付说明必须写「复现测试：<测试名>」` } };
      return { status: 200, body: { ok: true, v: 1, receipt: { orderId: "w1", sha256: sha(JSON.stringify(body)), eventSeq: 9, taskId: "T93", key: "k", sig: "s" } } };
    },
    readLend: async () => ({ status: "ok", file: { version: 2, enabled: true, lend: [ENTRY], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    peers: async () => [PEER],
    notify: async () => ({ ok: true }), retireAsk: async () => ({ ok: true }),
    clone: async () => ({ ok: true, dir }),
    removeDir: () => {},
    selfFp: () => FP, identity: () => ({ name: "lender", email: "l@x" }),
    push: {
      probe: async () => ({ ok: true }),
      work: async (t) => { pushed.push(t.head); return { ok: true }; },
      pr: async () => ({ ok: true, pr: 7 }),
    },
    verifyReceipt: async () => true, writeReceipt: async () => {},
    worker: {
      find: (n) => registry.get(n),
      create: async (n, cwd, _p, gate) => { if (await gate()) return { ok: false, error: "gate" }; registry.set(n, { sessionId: "thr-1", cwd }); return { ok: true }; },
      send: async (_n, _s, text) => {
        sent.push(text);
        const note = text.includes("补写交付说明") ? notes.shift() : undefined;
        if (note !== undefined) writeFileSync(join(dir, NOTE_FILE), `${note}\n`);
        return { ok: true, messageId: "m1" };
      },
      kill: async (n) => { registry.delete(n); return { ok: true }; },
      alive: async (n) => (registry.has(n) ? "running" : "no_window"),
    },
  };
  const tick = () => lendTick(d);
  /** 走到 worker 已收首条派单，再按 lend submit 落 work */
  const start = async (summary: string) => {
    for (let i = 0; i < 8 && !(getOrder(db, "w1")?.state === "started" && getOrder(db, "w1")?.submit === "sent"); i++) await tick();
    expect(getOrder(db, "w1")).toMatchObject({ state: "started", submit: "sent" });
    advance(db, "w1", "started", "result_pending", { work: { head: H2, summary, selfCheck: "逐条对了验收线" } });
  };
  const results = () => calls.filter((c) => c.op === "result").map((c) => c.body as { gen: number; deliver: { head: string; summary: string } });
  const amends = () => sent.filter((t) => t.includes("补写交付说明"));
  const release = () => calls.find((c) => c.op === "lease" && c.body.action === "release")?.body;
  return { db, d, dir, tick, start, results, amends, pushed, release, clock, lease };
}

describe("B 侧：收到 delivery_note 补写说明重交", () => {
  test("A 拒收 delivery_note → worker 收到补写指令 → 同一 head、同一租约代际重交 → A 收下；没有新提交，没变 stopped", async () => {
    const h = harness({ replies: [{ code: DELIVERY_NOTE }], notes: [NOTE_OK] });
    await h.start("修好了 race");
    await h.tick();
    expect(getOrder(h.db, "w1")).toMatchObject({ state: "result_pending", payload: null, payloadSha: null });
    expect(h.amends()).toHaveLength(1);
    expect(h.amends()[0]).toContain("不要 git commit");
    expect(h.amends()[0]).toContain(join(h.dir, NOTE_FILE));
    expect(h.amends()[0]).toContain("A 拒收");
    await h.tick();
    const row = getOrder(h.db, "w1")!;
    expect(row.state).toBe("acked");
    const [first, second] = h.results();
    expect(h.results()).toHaveLength(2);
    expect(first).toMatchObject({ gen: 1, deliver: { head: H2, summary: "修好了 race" } });
    expect(second).toMatchObject({ gen: 1, deliver: { head: H2, summary: NOTE_OK } });
    expect(new Set(h.pushed)).toEqual(new Set([H2])); // 只推过 worker 当初交的那个 head
    expect(row.work?.head).toBe(H2);
    expect(h.release()).toBeUndefined();
    expect(existsSync(join(h.dir, NOTE_FILE))).toBe(false);
  });

  test("连续 2 次补写都不合格 → stopped，原因写明补写次数并告诉 A", async () => {
    const h = harness({ replies: [{ code: DELIVERY_NOTE }, { code: DELIVERY_NOTE }, { code: DELIVERY_NOTE }], notes: [NOTE_OK, NOTE_OK] });
    await h.start("修好了 race");
    for (let i = 0; i < 6 && getOrder(h.db, "w1")!.state === "result_pending"; i++) await h.tick();
    const row = getOrder(h.db, "w1")!;
    expect(row.state).toBe("stopped");
    expect(row.reason).toContain("补写说明 2 次仍不合格");
    expect(h.amends()).toHaveLength(2);
    expect(h.results()).toHaveLength(3);
    expect(h.release()).toMatchObject({ reason: "stopped" });
  });

  test("worker 写回的摘要仍缺复现测试：算一次补写，2 次后 stopped，不发给 A", async () => {
    const h = harness({ replies: [{ code: DELIVERY_NOTE }], notes: ["还是没写", "又没写"] });
    await h.start("修好了 race");
    for (let i = 0; i < 6 && getOrder(h.db, "w1")!.state === "result_pending"; i++) await h.tick();
    expect(getOrder(h.db, "w1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("补写说明 2 次仍不合格") });
    expect(h.amends()).toHaveLength(2);
    expect(h.amends()[1]).toContain("仍没有『复现测试");
    expect(h.results()).toHaveLength(1);
  });

  test("补写期间续租照常；租约被判过期就按现有规则停（不新开口子）", async () => {
    const h = harness({ replies: [{ code: DELIVERY_NOTE }] });
    await h.start("修好了 race");
    await h.tick();
    expect(amendState(h.d, "w1")).toMatchObject({ n: 1, waiting: true, told: true, head: H2 });
    h.clock.t += 61_000;
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("result_pending");
    h.lease.refuse = "lease_expired";
    h.clock.t += 61_000;
    await h.tick();
    expect(getOrder(h.db, "w1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("续租被拒：lease_expired") });
    expect(h.results()).toHaveLength(1);
  });
});

describe("B 侧：发出前自查", () => {
  test("acceptance 要复现测试、摘要里没有 → 先补写，补好才发（A 只收到一次）", async () => {
    const h = harness({ acceptance: ["只推订单分支", FIX_STRATEGY_RULE], notes: [NOTE_OK] });
    await h.start("修好了 race");
    await h.tick();
    expect(h.results()).toHaveLength(0);
    expect(h.pushed).toEqual([]);
    expect(h.amends()).toHaveLength(1);
    expect(h.amends()[0]).toContain("发出前自查");
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("acked");
    expect(h.results()).toEqual([expect.objectContaining({ gen: 1, deliver: expect.objectContaining({ head: H2, summary: NOTE_OK }) })]);
  });

  test("acceptance 里没有这条要求的单子不受影响：直接发，不发补写指令", async () => {
    const h = harness();
    await h.start("实现了 x");
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("acked");
    expect(h.amends()).toEqual([]);
    expect(h.results()).toEqual([expect.objectContaining({ deliver: expect.objectContaining({ summary: "实现了 x" }) })]);
    expect(amendState(h.d, "w1")).toBeNull();
  });

  test("acceptance 要求、摘要已写复现测试 → 直接发", async () => {
    const h = harness({ acceptance: [FIX_STRATEGY_RULE] });
    await h.start(NOTE_OK);
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("acked");
    expect(h.amends()).toEqual([]);
  });
});

describe("新旧版本兼容", () => {
  test("旧版 B 不认识 delivery_note：解析成普通拒收码，落进现有 stopped 分支，不抛", async () => {
    // A 侧新码经 bridge 回 400 + {code}：旧 B 的 lendRequest 原样带出 code（不是 bad_response / transport，不会原样重发）
    const call = async () => ({ status: DELIVERY_NOTE_STATUS[DELIVERY_NOTE], body: { ok: false, code: DELIVERY_NOTE, error: "缺复现测试" } });
    expect(await lendRequest(call, "team-a", "result", {})).toMatchObject({ ok: false, code: DELIVERY_NOTE });
    // 旧版 B 对它只有「陌生 code」这条路：同一个循环里换一个本版也不认识的码走一遍，就是 stopped 并告诉 A
    const h = harness({ replies: [{ code: "some_future_code" }] });
    await h.start("修好了 race");
    await h.tick();
    expect(getOrder(h.db, "w1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("A 不收结论：some_future_code") });
    expect(h.release()).toMatchObject({ reason: "stopped" });
    expect(h.amends()).toEqual([]);
  });
});

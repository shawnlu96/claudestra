/**
 * i28-W2 推送循环（src/lib/lend-dispatch.ts）：注入假的发送（等于假 peerFetch）和真的内存台账（候选、应答入账、TTL 撤回都走真的
 * ledger 代码）。覆盖：退避 5 / 15 / 30 / 60 秒；丢请求、丢响应后 TTL 一定撤回；重复确认不续命；bridge 重启全部重推；
 * 从没 hello 过的 peer 不推；不是 E2E 回来的应答、单号对不上的应答不算数；前提不满足就不发（绝不明文）；同一时刻只跑一轮。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { createPushLoop, backoffAfter, type DispatchDeps, type PushSend } from "../src/lib/lend-dispatch.js";
import type { OfferRequest } from "../src/lib/lend-wire-v2.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { pushCandidates } from "../src/lib/ledger-lend-peers.js";
import { PUSH_ACK_TTL_MS, PUSH_CLAIM_TTL_MS, pushTtlDue } from "../src/lib/ledger-lend-peers-ttl.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const REPO = "shawnlu96/claudestra";
let db: Database;
let now: number;
let borrow: BorrowEntry[];
const dir = mkdtempSync(join(tmpdir(), "lend-dispatch-test-"));

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: { borrow: async () => borrow, notifyPm: async () => {}, result: { reportDir: () => dir, writeReport: () => {}, sign: () => null, peerFp: async () => null } },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
let seq = 0;
const hello = (peer = "mate") => run(["lend-hello", "--", peer, JSON.stringify({
  v: 1, proto: 2, boot: "boot-0001", seq: ++seq, grant: { until: now + 86_400_000, roles: ["review"], repos: [REPO], ordersPerDay: 9, ordersLeftToday: 9 },
  slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null })], "owner");
async function offer(id: string, peer = "mate"): Promise<string> {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id, title: id, kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = '${id}'`);
  return (await run(["lend-offer", id, "--peer", peer, "--repo", REPO, "--pr", "4"])).orderId;
}

/** 假的出借方 B：按剧本处理每一次推送——丢请求（B 没看到）、丢响应（B 收下了、A 没拿到应答）、正常应答 */
type Act = "ok" | "drop_request" | "drop_response" | "plaintext" | "foreign";
function lender() {
  const seen = new Map<string, number>();
  const script: Act[] = [];
  const sends: { peer: string; ids: string[] }[] = [];
  const send = async (peer: string, body: OfferRequest): Promise<PushSend> => {
    const ids = body.orders.map((o) => o.orderId);
    sends.push({ peer, ids });
    const act = script.shift() ?? "ok";
    if (act === "drop_request") throw new Error("中继断了");
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1); // B 按 orderId 去重：同一单收几次都只是一行
    if (act === "drop_response") throw new Error("等应答超时");
    const answer = { ok: true, v: 1, accepted: act === "foreign" ? [...ids, "lend:X:s1:r1:a0"] : ids, refused: [] };
    return { status: 200, e2e: act !== "plaintext", body: answer };
  };
  return { seen, script, sends, send };
}

let logs: string[];
let problem: string | null;
let sweeps: number;
function loopWith(send: DispatchDeps["send"]) {
  return createPushLoop({
    now: () => now, candidates: (t) => pushCandidates(db, t), problem: async () => problem, send,
    record: async (peer, answer) => (await run(["lend-pushed", "--", peer, JSON.stringify(answer)], "owner")).ok === true,
    ttlDue: (t) => pushTtlDue(db, t).length > 0,
    sweep: async () => { sweeps++; await run(["lend-sweep"], "owner"); },
    log: (m) => logs.push(m),
  });
}
const seenAt = (id: string) => (db.query("SELECT seenAt FROM lend_orders WHERE orderId = ?").get(id) as { seenAt: number | null }).seenAt;

beforeEach(async () => {
  db = openLedger(":memory:");
  now = 1_000_000;
  seq = 0;
  logs = [];
  problem = null;
  sweeps = 0;
  borrow = ["mate", "old"].map((peer) => ({ peer, projects: [P], roles: ["review"], maxOpen: 5 }));
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  await hello();
});
afterEach(() => closeLedger(":memory:"));

describe("推送循环", () => {
  test("退避：失败后 5 秒、15 秒、30 秒，之后每 60 秒", async () => {
    expect([1, 2, 3, 4, 9].map(backoffAfter)).toEqual([5_000, 15_000, 30_000, 60_000, 60_000]);
    await offer("T1");
    const b = lender();
    b.script.push(...Array<Act>(10).fill("drop_request"));
    const loop = loopWith(b.send);
    const at: number[] = [];
    for (let t = 0; t <= PUSH_ACK_TTL_MS; t += 1_000) {
      now = 1_000_000 + t;
      const before = b.sends.length;
      await loop.tick();
      if (b.sends.length > before) at.push(t);
    }
    expect(at).toEqual([0, 5_000, 20_000, 50_000, 110_000]); // 下一次本该在 170 秒，但 120 秒一过 TTL 已把单撤了
  });

  test("丢请求：一直推不到，2 分钟一过 TTL 撤回；之后 B 再来领拿到 cancelled", async () => {
    const id = await offer("T1");
    const b = lender();
    b.script.push(...Array<Act>(20).fill("drop_request"));
    const loop = loopWith(b.send);
    for (let t = 0; t <= PUSH_ACK_TTL_MS; t += 5_000) {
      now = 1_000_000 + t;
      await loop.tick();
    }
    expect(getLendOrder(db, id)!.status).toBe("pooled");
    now += 5_000;
    expect(await loop.tick()).toMatchObject({ swept: true });
    expect(getLendOrder(db, id)!.status).toBe("cancelled");
    expect(b.seen.size).toBe(0);
    expect(await run(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: id, worker: "w1" })], "owner")).toMatchObject({ current: { lend: "cancelled" } });
  });

  test("丢响应：B 收下了但 A 没拿到应答 → 5 秒后重推，B 去重，确认只记一次；之后 3 分钟没领照样撤回", async () => {
    const id = await offer("T1");
    const b = lender();
    b.script.push("drop_response", "ok");
    const loop = loopWith(b.send);
    await loop.tick();
    expect(seenAt(id)).toBeNull();
    now += 5_000;
    await loop.tick();
    expect(b.seen.get(id)).toBe(2);
    expect(seenAt(id)).toBe(now);
    const acked = now;
    now += 60_000;
    await loop.tick();
    expect(b.sends.length).toBe(2); // 确认过的单不再推
    now = acked + PUSH_CLAIM_TTL_MS + 1;
    await loop.tick();
    expect(getLendOrder(db, id)!.status).toBe("cancelled");
  });

  test("响应一直丢：B 那边有这一单也没用，A 没确认就按 2 分钟撤回（之后 B 领拿到 cancelled）", async () => {
    const id = await offer("T1");
    const b = lender();
    b.script.push(...Array<Act>(20).fill("drop_response"));
    const loop = loopWith(b.send);
    for (let t = 0; t <= PUSH_ACK_TTL_MS + 5_000; t += 5_000) {
      now = 1_000_000 + t;
      await loop.tick();
    }
    expect(b.seen.get(id)).toBeGreaterThan(1);
    expect(getLendOrder(db, id)!.status).toBe("cancelled");
  });

  test("bridge 重启：发送状态在内存里，新循环把所有池单重推一遍；B 再确认一次不挪确认时间（不续命）", async () => {
    const a = await offer("T1");
    const b = lender();
    await loopWith(b.send).tick();
    const first = seenAt(a);
    expect(first).toBe(now);
    now += 30_000;
    await loopWith(b.send).tick(); // 重启后的第一轮
    expect(b.sends.map((s) => s.ids)).toEqual([[a], [a]]);
    expect(seenAt(a)).toBe(first);
  });

  test("从没 hello 过的 peer、前提不满足的 peer 都不发；不是 E2E 回来的、单号对不上的应答不算确认", async () => {
    await offer("T1", "old");
    const b = lender();
    await loopWith(b.send).tick();
    expect(b.sends).toEqual([]);
    const id = await offer("T2");
    problem = "没有端到端加密记录";
    await loopWith(b.send).tick();
    expect(b.sends).toEqual([]);
    expect(logs.join("\n")).toContain("端到端");
    problem = null;
    b.script.push("plaintext", "foreign");
    const loop = loopWith(b.send);
    await loop.tick();
    now += 5_000;
    await loop.tick();
    expect(b.sends.length).toBe(2);
    expect(seenAt(id)).toBeNull();
    expect(logs.join("\n")).toMatch(/端到端加密回来|对不上/);
  });

  test("同一时刻只跑一轮；一轮最多推 20 单", async () => {
    for (let i = 0; i < 22; i++) await offer(`T${i}`);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const b = lender();
    const loop = loopWith(async (peer, body) => { await gate; return b.send(peer, body); });
    const first = loop.tick();
    expect(await loop.tick()).toBeNull();
    release();
    await first;
    expect(b.sends[0]!.ids.length).toBe(20);
    await loop.tick();
    expect(b.sends[1]!.ids.length).toBe(2);
  });
});

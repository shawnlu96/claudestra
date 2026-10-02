/**
 * i28-W3 版本混搭（docs/design/remote-capacity.md §8.5）：B 是真的 lend 循环（tests/lend-harness.ts 的假 worker），A 是真台账——
 * 内存库 + `ledger lend-*` CLI（runLedger），bridge 那一层只照 local-api/lend.ts 把 CLI 结果映射成 HTTP 状态；旧 A 的 hello / beat 回 404。
 * A 的推送循环用 W2 的真函数（pushCandidates → B 的 admitOrders → `ledger lend-pushed`），推送 TTL 用真 `ledger lend-sweep`。
 * 四格矩阵、A 降级、推不过来的 peer；B 发出的每个 v1 正文都过 A 的 v1 严格解析器（parseLendRequest）。两边时钟同一个，手拨。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { admitOrders } from "../src/lib/lend-inbox.js";
import { getOrder, type LendState } from "../src/lib/lend-journal.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { getLendPeer, pushCandidates } from "../src/lib/ledger-lend-peers.js";
import { pushTtlDue } from "../src/lib/ledger-lend-peers-ttl.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { LEND_STATUS, parseLendRequest, type LendEndpoint } from "../src/lib/lend-wire.js";
import { LEND_V2_STATUS, offerBody } from "../src/lib/lend-wire-v2.js";
import { runLedger } from "../src/manager/ledger.js";
import { FP, harness } from "./lend-harness.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const REPO = "shawnlu96/claudestra";
/** A 给 B 记的名字；B 给 A 记的名字是 harness 的 team-a */
const MATE = "mate";
const dir = mkdtempSync(join(tmpdir(), "lend-compat-"));
let db: Database;
let h: ReturnType<typeof harness>;
let borrow: BorrowEntry[];

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => h.d.now(),
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => dir, writeReport: () => {}, sign: () => null, peerFp: async () => FP, remoteHead: async () => ({ ok: true as const, head: H }) },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;

const CLI: Record<string, string> = { poll: "lend-poll", claim: "lend-claim", lease: "lend-lease", result: "lend-write", hello: "lend-hello", beat: "lend-beat" };
const STATUS: Record<string, number> = { ...LEND_STATUS, ...LEND_V2_STATUS };

/** A 的 bridge：只做 local-api/lend.ts 那层映射（ok → 200 去掉 ok / notified；拒绝码 → 对应状态）；旧 A 没有 hello / beat 路由 → 404 */
function aSide(opts: { old: () => boolean }) {
  const v1: { op: string; body: Record<string, unknown> }[] = [];
  const v2: { op: string; body: Record<string, unknown> }[] = [];
  const bridge = async (_peer: string, op: string, body: Record<string, unknown>) => {
    (op === "hello" || op === "beat" ? v2 : v1).push({ op, body });
    if ((op === "hello" || op === "beat") && opts.old()) return { status: 404, body: { ok: false, error: "not found" } };
    const r = await run([CLI[op], "--", MATE, JSON.stringify(body)], "owner");
    if (r.ok) {
      const { ok: _ok, notified: _n, ...rest } = r;
      return { status: 200, body: { ok: true, ...rest } };
    }
    const code = (r.current?.lend ?? r.code) as string;
    return { status: STATUS[code] ?? 500, body: { ok: false, code, error: String(r.error ?? code) } };
  };
  return { v1, v2, bridge };
}

/** A 的推送循环一轮（W2 真函数）：hello 新鲜、授权还在的 v2 peer 名下的池单推给 B，B 的应答经 `ledger lend-pushed` 入账 */
async function pushOnce(reachable = true): Promise<string[]> {
  const cands = pushCandidates(db, h.d.now()).filter((c) => c.peer === MATE);
  if (!cands.length || !reachable) return [];
  const body = offerBody(cands.map((c) => c.summary));
  const got = await admitOrders(h.d, { peer: "team-a", fp: FP }, body.orders, "push");
  await run(["lend-pushed", "--", MATE, JSON.stringify({ ok: true, v: 1, ...got })], "owner");
  return got.accepted;
}

async function offer(id: string): Promise<string> {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now: h.d.now() }, { project: P, id, title: id, kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = '${id}'`);
  return (await run(["lend-offer", id, "--peer", MATE, "--repo", REPO, "--pr", "4"])).orderId;
}

/** B 接线：v1 永远走 A；newB = 有 v2（hello / beat） */
function wire(newB: boolean, a: ReturnType<typeof aSide>): void {
  h.d.call = (peer, op, body) => a.bridge(peer, op, body);
  if (newB) h.d.v2 = { boot: "boot-cmpt-0001", call: (peer, op, body) => a.bridge(peer, op, body) };
}

/** 跑 n 轮、每轮 5 秒（一个 pass） */
async function passes(n: number, push?: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (push) await push();
    await h.tick();
    h.advanceTime(5_000);
  }
}

const bState = (id: string): LendState | undefined => getOrder(h.db, id)?.state;
const v1Ok = (a: ReturnType<typeof aSide>) => {
  for (const c of a.v1) expect([c.op, parseLendRequest(c.op === "result" ? "result" : (c.op as LendEndpoint), c.body).ok]).toEqual([c.op, true]);
};
const ops = (a: ReturnType<typeof aSide>) => a.v1.map((c) => (c.op === "lease" ? `lease:${c.body.action}` : c.op));

beforeEach(() => {
  db = openLedger(":memory:");
  h = harness();
  borrow = [{ peer: MATE, projects: [P], roles: ["review"], maxOpen: 2 }];
  setMeta(db, { actor: "owner", now: h.d.now() }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("四格矩阵", () => {
  test("旧 A × 旧 B：只有 v1——poll 领单、逐单续租；A 从不推送", async () => {
    const a = aSide({ old: () => true });
    wire(false, a);
    const id = await offer("T1");
    await passes(6);
    expect(bState(id)).toBe("started");
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    h.advanceTime(61_000);
    await h.tick();
    expect(ops(a)).toContain("lease:renew");
    expect(a.v2).toEqual([]);
    v1Ok(a);
  });

  test("旧 A × 新 B：hello 404 → proto 1，30 秒轮询、逐单续租；B 不向旧 A 发任何 v2 字段", async () => {
    const a = aSide({ old: () => true });
    wire(true, a);
    const id = await offer("T1");
    await passes(6);
    expect(bState(id)).toBe("started");
    h.advanceTime(61_000);
    await passes(2);
    expect(ops(a)).toContain("lease:renew");
    expect(a.v2.every((c) => c.op === "hello")).toBe(true); // 404 之后 beat 一次都没发
    v1Ok(a);
    const polls = a.v1.filter((c) => c.op === "poll").length;
    await passes(7); // 35 秒
    expect(a.v1.filter((c) => c.op === "poll").length).toBe(polls + 1);
  });

  test("新 A × 旧 B：B 从不 hello → A 不推送、推送 TTL 不撤它的单；B 靠轮询照样领", async () => {
    const a = aSide({ old: () => false });
    wire(false, a);
    const id = await offer("T1");
    expect(pushCandidates(db, h.d.now())).toEqual([]);
    h.advanceTime(4 * 60_000);
    expect(pushTtlDue(db, h.d.now())).toEqual([]);
    await run(["lend-sweep"], "owner");
    expect(getLendOrder(db, id)!.status).toBe("pooled");
    await passes(6);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect(getLendPeer(db, MATE)).toBeNull();
    v1Ok(a);
  });

  test("新 A × 新 B：hello → proto 2；推送收单、下一个 pass 领；beat 续租（A 的截止跟着走），没有逐单 renew", async () => {
    const a = aSide({ old: () => false });
    wire(true, a);
    await passes(1);
    expect(getLendPeer(db, MATE)).toMatchObject({ proto: 3, grant: expect.objectContaining({ repos: [REPO] }) });
    const id = await offer("T1");
    expect(await pushOnce()).toEqual([id]);
    expect(getOrder(h.db, id)!.preview.source).toBe("push");
    await passes(1);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    await passes(5);
    const until = getLendOrder(db, id)!.leaseUntil!;
    h.advanceTime(20_000);
    await h.tick();
    expect(getLendOrder(db, id)!.leaseUntil!).toBeGreaterThan(until);
    expect(ops(a)).not.toContain("lease:renew");
    expect(a.v2.some((c) => c.op === "beat")).toBe(true);
    v1Ok(a);
  });
});

describe("A 降级与推不过来", () => {
  test("A 从新降到旧：一个 hello 周期（≤60 秒）内切回 30 秒轮询；beat 回 404 的当轮就逐单续租", async () => {
    let old = false;
    const a = aSide({ old: () => old });
    wire(true, a);
    await passes(1);
    const id = await offer("T1");
    await pushOnce();
    await passes(6);
    expect(bState(id)).toBe("started");
    old = true;
    const renewsBefore = ops(a).filter((o) => o === "lease:renew").length;
    h.advanceTime(70_000); // beat 到点（A 已降级）
    await h.tick();
    expect(ops(a).filter((o) => o === "lease:renew").length).toBe(renewsBefore + 1); // 同一轮切到逐单续租
    const polls = a.v1.filter((c) => c.op === "poll").length;
    await passes(13); // ≤ 60 秒
    expect(a.v1.filter((c) => c.op === "poll").length).toBeGreaterThanOrEqual(polls + 2);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    v1Ok(a);
  });

  test("推不过来（只单向配对 / 推送一直失败）：B 10 分钟没收到推送就 30 秒轮询，赶在 A 的 2 分钟推送 TTL 之前领到", async () => {
    const a = aSide({ old: () => false });
    wire(true, a);
    await passes(8); // B 早就在跑：启动那一轮的立刻 poll 已经过去
    const id = await offer("T1");
    expect(pushCandidates(db, h.d.now()).map((c) => c.summary.orderId)).toEqual([id]); // A 以为推得过去
    await passes(8, () => pushOnce(false)); // 40 秒，推送全丢
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    h.advanceTime(2 * 60_000);
    await run(["lend-sweep"], "owner");
    expect(getLendOrder(db, id)!.status).toBe("claimed");
  });

  test("推送正常时轮询降到 5 分钟兜底", async () => {
    const a = aSide({ old: () => false });
    wire(true, a);
    await passes(1);
    const id = await offer("T1");
    await pushOnce();
    const polls = () => a.v1.filter((c) => c.op === "poll").length;
    const before = polls();
    await passes(24, () => pushOnce()); // 2 分钟
    expect(polls() - before).toBeLessThanOrEqual(1);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
  });
});

describe("收单和 claim 之间的重启 / 断线（和 W2 推送 TTL 一起）", () => {
  test("收下之后马上重启：下一个 pass 照样领，A 的 TTL 不撤", async () => {
    const a = aSide({ old: () => false });
    wire(true, a);
    await passes(1);
    const id = await offer("T1");
    await pushOnce();
    h.d.v2 = { ...h.d.v2!, boot: "boot-cmpt-0002" }; // 调度服务重启
    await passes(1);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    h.advanceTime(4 * 60_000);
    await run(["lend-sweep"], "owner");
    expect(getLendOrder(db, id)!.status).not.toBe("cancelled");
  });

  test("收下之后断线超过 A 的 TTL：A 撤回，B 回来 claim 拿到 cancelled → declined，不起 worker", async () => {
    const a = aSide({ old: () => false });
    wire(true, a);
    await passes(1);
    const id = await offer("T1");
    await pushOnce();
    h.advanceTime(3 * 60_000 + 1);
    await run(["lend-sweep"], "owner");
    expect(getLendOrder(db, id)!.status).toBe("cancelled");
    await passes(3);
    expect(bState(id)).toBe("declined");
    expect(h.log.created).toEqual([]);
    expect(a.v1.filter((c) => c.op === "claim").length).toBe(1);
  });
});

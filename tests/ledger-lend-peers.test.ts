/**
 * i28-W2 A 侧 v2：hello 入账（启动号 + 序号防回滚）、可用槽（min(上报空闲, maxOpen − 未结单)，hello 超 180 秒 / 收回 / 用完 / 暂停按 0）、
 * 批量 beat（只续这个 peer 持有、未过期、代数对的单，逐单回 verdict，摘要再脱敏一次）、收回授权（PM 已定：审查单 clean 自动重排，
 * 写单要 A 自己核对分支没推送，clean:false / 核不了 / 有推送一律交 PM，收回后这个 peer 立刻 0 槽）、推送应答入账。
 * 全部经 `ledger lend-*` CLI（runLedger）跑内存库；远端分支状态是注入的假依赖。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getLendPeer } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import { closeLedger, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { LEND_PEERS_SCHEMA } from "../src/lib/ledger-lend-schema.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BranchState } from "../src/manager/ledger-lend-peer-cmds.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = "shawnlu96/claudestra";
const DAY = 86_400_000;
let db: Database;
let now: number;
let notices: string[];
let borrow: BorrowEntry[];
let branch: BranchState;
let branchAsked: string[];
const dir = mkdtempSync(join(tmpdir(), "lend-peers-test-"));
const key = instanceKeySync(dir);

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow,
    notifyPm: async (_p: string, text: string) => { notices.push(text); },
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async () => ({ ok: true as const, head: BASE }), peerFp: async (peer: string) => (peer === "mate" ? "abcd-ef01-2345-6789" : null),
    },
    branchState: async (_repo: string, b: string) => { branchAsked.push(b); return branch; },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown, peer = "mate") => run([`lend-${ep}`, "--", peer, typeof body === "string" ? body : JSON.stringify(body)], "owner");
const refusedWith = (r: Record<string, any>, lend: string) => {
  expect(r.ok).toBe(false);
  expect(r.current?.lend).toBe(lend);
};
const grant = (over: Record<string, unknown> = {}) => ({ until: now + DAY, roles: ["review"], repos: [REPO], ordersPerDay: 10, ordersLeftToday: 10, ...over });
let seq = 0;
const helloBody = (over: Record<string, unknown> = {}) => ({
  v: 1, proto: 2, boot: "boot-0001", seq: ++seq, grant: grant(), slots: { codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null, ...over,
});
const hello = (over: Record<string, unknown> = {}, peer = "mate") => call("hello", helloBody(over), peer);
const capacity = async (peer = "mate") => ((await run(["lend-peers", "--peer", peer])).peers as Record<string, any>[])[0]!;
const line = (orderId: string, over: Record<string, unknown> = {}) => ({ orderId, gen: 1, phase: "working", lastActivityAt: now, excerpt: "跑测试中", ...over });
const beat = (orders: unknown[], peer = "mate") => call("beat", { v: 1, orders }, peer);

function card(id: string, stage = "review"): void {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
  db.run(`UPDATE tasks SET stage = '${stage}', headSHA = ${stage === "build" ? "NULL" : `'${H}'`}, round = 1 WHERE id = '${id}'`);
}
/** 挂一单给 mate，再让 mate 领下（租约代数 1） */
async function held(id = "T9", worker = "agent-lend-0123456789"): Promise<string> {
  const { orderId } = await run(["lend-offer", id, "--peer", "mate", "--repo", REPO, ...(id.startsWith("B") ? [] : ["--pr", "12"])]);
  expect((await call("claim", { v: 1, orderId, worker })).ok).toBe(true);
  return orderId;
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  notices = [];
  branch = "absent";
  branchAsked = [];
  borrow = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }, { peer: "other", projects: [P], roles: ["review"], maxOpen: 2 }];
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  card("T9");
});
afterEach(() => closeLedger(":memory:"));

describe("迁移", () => {
  test("上一版的库升上来补齐 lend_peers 与 beatAt / beat；同一迁移再跑两次不报错、不动已有行", () => {
    const file = join(mkdtempSync(join(tmpdir(), "lend-peers-mig-")), "ledger.sqlite");
    const d = openLedger(file);
    d.run("DROP TABLE lend_peers");
    d.run("ALTER TABLE lend_orders DROP COLUMN beat");
    d.run("ALTER TABLE lend_orders DROP COLUMN beatAt");
    d.run(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - 1}`);
    closeLedger(file);
    const m = openLedger(file);
    expect(m.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION });
    m.run("INSERT INTO lend_peers (peer, fp, proto, boot, seq, slots, helloAt) VALUES ('mate', NULL, 2, 'boot-0001', 1, '{}', 5)");
    LEND_PEERS_SCHEMA(m);
    LEND_PEERS_SCHEMA(m);
    expect(m.query("SELECT peer, proto, seq FROM lend_peers").all()).toEqual([{ peer: "mate", proto: 2, seq: 1 }]);
    expect((m.query("PRAGMA table_info(lend_orders)").all() as { name: string }[]).filter((c) => c.name.startsWith("beat")).map((c) => c.name).sort())
      .toEqual(["beat", "beatAt"]);
    closeLedger(file);
  });
});

describe("hello", () => {
  test("入账到 lend_peers；回包只有 proto / helloMs / beatMs（bridge 只剥 ok / notified，多一个字段对方就拒）", async () => {
    expect(await hello()).toEqual({ ok: true, v: 1, proto: 3, helloMs: 60_000, beatMs: 15_000 });
    expect(getLendPeer(db, "mate")).toMatchObject({ proto: 2, boot: "boot-0001", fp: "abcd-ef01-2345-6789", helloAt: now, grant: grant(), paused: null });
  });

  test("同一启动号里序号没涨的 hello 不入账（迟到的旧 hello 不会把收回的授权翻回来）；换启动号重新计", async () => {
    await hello({ seq: 5 });
    await hello({ seq: 6, grant: null });
    expect(await hello({ seq: 5 })).toMatchObject({ ok: true });
    expect(getLendPeer(db, "mate")!.grant).toBeNull();
    await hello({ seq: 1, boot: "boot-0002" });
    expect(getLendPeer(db, "mate")).toMatchObject({ boot: "boot-0002", seq: 1, grant: grant() });
  });

  test("严格：多字段、缺字段、proto 1、名额越界都拒；只给 bridge（owner）调", async () => {
    refusedWith(await hello({ extra: 1 }), "invalid");
    const { paused: _p, ...noPaused } = helloBody();
    refusedWith(await call("hello", noPaused), "invalid");
    refusedWith(await hello({ proto: 1 }), "invalid");
    refusedWith(await hello({ slots: { codex: { total: 101, busy: 0 }, claude: { total: 0, busy: 0 } } }), "invalid");
    refusedWith(await hello({ grant: grant({ roles: ["review", "review"] }) }), "invalid");
    expect(await run(["lend-hello", "--", "mate", JSON.stringify(helloBody())])).toMatchObject({ ok: false, code: "forbidden" });
    expect(getLendPeer(db, "mate")).toBeNull();
  });
});

describe("可用槽", () => {
  test("没 hello = proto 1、0 槽；有 hello = min(上报空闲, maxOpen − A 在它那里的未结单)", async () => {
    expect(await capacity()).toMatchObject({ proto: 1, slots: { codex: 0, claude: 0 }, why: expect.stringContaining("proto 1") });
    await hello({ slots: { codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 0 } } });
    expect(await capacity()).toMatchObject({ proto: 2, open: 0, slots: { codex: 2, claude: 0 }, why: null }); // maxOpen 2 封顶
    await held();
    expect(await capacity()).toMatchObject({ open: 1, slots: { codex: 1 } });
    await hello({ slots: { codex: { total: 3, busy: 3 }, claude: { total: 0, busy: 0 } } });
    expect((await capacity()).slots.codex).toBe(0);
  });

  test("hello 刚好 180 秒还算，过一毫秒就 0", async () => {
    await hello();
    now += 180_000;
    expect((await capacity()).slots.codex).toBe(2);
    now += 1;
    expect(await capacity()).toMatchObject({ slots: { codex: 0 }, why: expect.stringContaining("180") });
  });

  test("grant:null 后立刻 0；授权到期、今天用完、Codex 撞额度暂停也是 0", async () => {
    await hello({ grant: null });
    expect((await capacity()).slots.codex).toBe(0);
    await hello({ grant: grant({ until: now }) });
    expect((await capacity()).slots.codex).toBe(0);
    await hello({ grant: grant({ ordersLeftToday: 0 }) });
    expect((await capacity()).slots.codex).toBe(0);
    await hello({ paused: { reason: "codex_quota", until: now + 60_000 } });
    expect((await capacity()).slots.codex).toBe(0);
    await hello({ paused: { reason: "codex_quota", until: now } });
    expect((await capacity()).slots.codex).toBe(2);
  });
});

describe("beat", () => {
  test("续这一单的租约、记摘要（再脱敏一次）；回包逐单 verdict + 新租约", async () => {
    const id = await held();
    now += 5 * 60_000;
    const r = await beat([line(id, { excerpt: `跑测试 token sk-${"x".repeat(24)}` })]);
    expect(r).toMatchObject({ ok: true, v: 1, orders: [{ orderId: id, verdict: "ok", lease: { gen: 1, expiresAt: now + 600_000, ms: 600_000 } }] });
    const o = db.query("SELECT leaseUntil, beatAt, beat FROM lend_orders WHERE orderId = ?").get(id) as { leaseUntil: number; beatAt: number; beat: string };
    expect(o.leaseUntil).toBe(now + 600_000);
    expect(o.beatAt).toBe(now);
    expect(JSON.parse(o.beat)).toMatchObject({ gen: 1, phase: "working", at: now });
    expect(o.beat).not.toContain("x".repeat(24));
  });

  test("只作用于这个 peer 持有、活着、代数对的单：别家的、代数不对、没领的、已撤的、已结的、过期的各回各的 verdict，好的照续", async () => {
    const mine = await held();
    card("T10");
    const pooled = (await run(["lend-offer", "T10", "--peer", "mate", "--repo", REPO, "--pr", "3"])).orderId;
    const before = getLendOrder(db, mine)!.leaseUntil;
    const r = await beat([line(mine), line(mine.replace("a0", "a9")), line(pooled)], "other");
    expect(r.orders.map((x: { verdict: string }) => x.verdict)).toEqual(["not_found", "not_found", "not_found"]);
    expect(getLendOrder(db, mine)!.leaseUntil).toBe(before);
    expect((await beat([line(mine, { gen: 2 })])).orders[0]).toMatchObject({ verdict: "stale_gen", lease: null });
    db.run(`UPDATE lend_orders SET status = 'done' WHERE orderId = '${mine}'`);
    expect((await beat([line(mine)])).orders[0].verdict).toBe("done");
    db.run(`UPDATE lend_orders SET status = 'cancelled' WHERE orderId = '${mine}'`);
    expect((await beat([line(mine)])).orders[0].verdict).toBe("cancelled");
    db.run(`UPDATE lend_orders SET status = 'claimed', leaseUntil = ${now - 1} WHERE orderId = '${mine}'`);
    expect((await beat([line(mine)])).orders[0].verdict).toBe("lease_expired"); // 先扫过期：已进 unknown，交 PM
    expect(getLendOrder(db, mine)!.status).toBe("unknown");
  });

  test("请求体严格：同一单两次、超过 50 行、摘要超 1 KiB 或带控制字符都整批拒", async () => {
    const id = await held();
    refusedWith(await beat([line(id), line(id)]), "invalid");
    refusedWith(await beat(Array.from({ length: 51 }, (_, i) => line(`o${i}`))), "invalid");
    refusedWith(await beat([line(id, { excerpt: "字".repeat(400) })]), "invalid");
    refusedWith(await beat([line(id, { excerpt: "a\u0007b" })]), "invalid");
    refusedWith(await beat([line(id, { ended: { reason: "quota", clean: true } })]), "invalid");
  });
});

describe("收回授权（PM 已定：只对 proto 2）", () => {
  test("审查单 clean:true → released、解绑步骤、交 PM 一句；这个 peer 立刻 0 槽，单子不会重排回它", async () => {
    await hello();
    const id = await held();
    expect(listSteps(db, "T9").length).toBe(1);
    const r = await beat([line(id, { ended: { reason: "revoked", clean: true } })]);
    expect(r.orders[0]).toEqual({ orderId: id, verdict: "ok", lease: null });
    expect(getLendOrder(db, id)).toMatchObject({ status: "released" });
    expect(listSteps(db, "T9")).toEqual([]);
    expect(notices.join("\n")).toContain("已释放");
    expect(await capacity()).toMatchObject({ slots: { codex: 0 }, why: expect.stringContaining("收回") });
    expect(branchAsked).toEqual([]); // 审查单不查远端
  });

  test("clean:false → unknown 交 PM，不自动重排", async () => {
    await hello();
    const id = await held();
    await beat([line(id, { ended: { reason: "revoked", clean: false } })]);
    expect(getLendOrder(db, id)).toMatchObject({ status: "unknown" });
    expect(listSteps(db, "T9").length).toBe(1);
    expect(notices.join("\n")).toContain("结果不明");
  });

  test("proto 1（没有 hello 记录）报 clean:true 收回：不自动重排，按 stopped 交 PM；写单也不去查远端", async () => {
    const id = await held();
    expect(getLendPeer(db, "mate")).toBeNull();
    await beat([line(id, { ended: { reason: "revoked", clean: true } })]);
    expect(getLendOrder(db, id)).toMatchObject({ status: "unknown", reason: expect.stringContaining("proto 1") });
    expect(listSteps(db, "T9").length).toBe(1);
    card("B1", "build");
    const w = await held("B1");
    await beat([line(w, { ended: { reason: "revoked", clean: true } })]);
    expect(getLendOrder(db, w)!.status).toBe("unknown");
    expect(getWriteLease(db, "B1")).toMatchObject({ state: "held" });
    expect(branchAsked).toEqual([]);
  });

  test("别家的单、代数不对的单报收回：拒，什么都不动（授权也不动）", async () => {
    await hello();
    const id = await held();
    expect((await beat([line(id, { ended: { reason: "revoked", clean: true } })], "other")).orders[0].verdict).toBe("not_found");
    expect((await beat([line(id, { gen: 3, ended: { reason: "revoked", clean: true } })])).orders[0].verdict).toBe("stale_gen");
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect(getLendPeer(db, "mate")!.grant).not.toBeNull();
  });

  describe("写单", () => {
    beforeEach(async () => {
      card("B1", "build");
      await hello();
    });

    test("分支在远端不存在（没推过）→ 按 not_started 记 released、退回本机（sendBack：写租约结束，交 PM）", async () => {
      const id = await held("B1");
      branch = "absent";
      await beat([line(id, { ended: { reason: "revoked", clean: true } })]);
      expect(branchAsked).toEqual([getLendOrder(db, id)!.branch as string]);
      expect(getLendOrder(db, id)!.status).toBe("released");
      expect(getWriteLease(db, "B1")).toMatchObject({ state: "ended" });
      expect(notices.join("\n")).toContain("退回本机");
    });

    test("分支还停在起点也算干净；分支已有新推送、或远端核对不了 → unknown 交 PM", async () => {
      const a = await held("B1");
      branch = { head: BASE };
      await beat([line(a, { ended: { reason: "revoked", clean: true } })]);
      expect(getLendOrder(db, a)!.status).toBe("released");
      for (const [i, state] of ([[2, { head: "c".repeat(40) }], [3, null]] as const)) {
        card(`B${i}`, "build");
        const id = await held(`B${i}`);
        branch = state;
        await beat([line(id, { ended: { reason: "revoked", clean: true } })]);
        expect(getLendOrder(db, id)!.status).toBe("unknown");
        expect(getWriteLease(db, `B${i}`)).toMatchObject({ state: "held" });
      }
    });
  });
});

describe("推送应答（lend-pushed）", () => {
  test("接收的记一次确认（重复确认不挪时间），拒收的立刻撤回并告诉 PM；别家的单不动", async () => {
    const a = (await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO, "--pr", "1"])).orderId;
    card("T10");
    const b = (await run(["lend-offer", "T10", "--peer", "mate", "--repo", REPO, "--pr", "2"])).orderId;
    card("T11");
    const c = (await run(["lend-offer", "T11", "--peer", "other", "--repo", REPO, "--pr", "3"])).orderId;
    const answer = (accepted: string[], refused: { orderId: string; code: string }[] = []) => ({ ok: true, v: 1, accepted, refused });
    expect(await call("pushed", answer([a, c], [{ orderId: b, code: "no_grant" }]))).toMatchObject({ ok: true, acked: 1, withdrawn: [b] });
    const seen = (id: string) => (db.query("SELECT seenAt FROM lend_orders WHERE orderId = ?").get(id) as { seenAt: number | null }).seenAt;
    expect(seen(a)).toBe(now);
    expect(seen(c)).toBeNull();
    expect(getLendOrder(db, b)).toMatchObject({ status: "cancelled", reason: expect.stringContaining("no_grant") });
    expect(notices.join("\n")).toContain("拒收");
    const first = now;
    now += 60_000;
    expect(await call("pushed", answer([a]))).toMatchObject({ acked: 0 });
    expect(seen(a)).toBe(first);
    refusedWith(await call("pushed", { ...answer([a]), extra: 1 }), "invalid");
    expect(listLendOrders(db, "T11")[0]!.status).toBe("pooled");
  });
});

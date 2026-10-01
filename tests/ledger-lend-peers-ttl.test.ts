/**
 * i28-W2 推送候选与推送 TTL：只推给 hello 过、hello 新鲜、授权还在的 v2 peer；发往 v2 peer 的池单 2 分钟没确认、或确认后 3 分钟没被领，
 * `lend-sweep` 就按 withdrawPooledLend（CAS）撤回——auto 卡不打扰 PM（调度器的池同步会重排），手挂的卡告诉 PM；没 hello 过的 peer 不受影响。
 * 撤回和 claim 两个进程同时抢：只有一个赢。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
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
let notices: string[];
let borrow: BorrowEntry[];
const dir = mkdtempSync(join(tmpdir(), "lend-ttl-test-"));

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async (_p: string, text: string) => { notices.push(text); },
    result: { reportDir: () => dir, writeReport: () => {}, sign: () => null, peerFp: async () => null },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown, peer = "mate") => run([`lend-${ep}`, "--", peer, JSON.stringify(body)], "owner");
let seq = 0;
const hello = (peer = "mate", over: Record<string, unknown> = {}) => call("hello", {
  v: 1, proto: 2, boot: "boot-0001", seq: ++seq, grant: { until: now + 86_400_000, roles: ["review"], repos: [REPO], ordersPerDay: 9, ordersLeftToday: 9 },
  slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null, ...over,
}, peer);
const sweep = () => run(["lend-sweep"], "owner");
const ack = (ids: string[], peer = "mate") => call("pushed", { ok: true, v: 1, accepted: ids, refused: [] }, peer);
const status = (id: string) => getLendOrder(db, id)!.status;

function card(id: string): void {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id, title: id, kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = '${id}'`);
}
async function offer(id: string, peer = "mate"): Promise<string> {
  card(id);
  return (await run(["lend-offer", id, "--peer", peer, "--repo", REPO, "--pr", "4"])).orderId;
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  seq = 0;
  notices = [];
  borrow = ["mate", "old", "quiet"].map((peer) => ({ peer, projects: [P], roles: ["review"], maxOpen: 3 }));
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("推送候选", () => {
  test("只给 hello 过、hello 新鲜、授权还在的 v2 peer；摘要就是 v1 poll 的那几个字段", async () => {
    await hello("mate");
    await hello("quiet");
    const a = await offer("T1", "mate");
    await offer("T2", "old"); // 从没 hello 过（proto 1）
    await offer("T3", "quiet");
    now += 170_000;
    await hello("mate"); // mate 保活，quiet 不再 hello
    now += 20_000;
    const c = pushCandidates(db, now);
    expect(c.map((x) => x.peer)).toEqual(["mate"]);
    expect(Object.keys(c[0]!.summary)).toEqual(["orderId", "taskId", "step", "family", "repo", "pr", "head", "round", "specRev", "offeredAt"]);
    expect(c[0]!.summary).toMatchObject({ orderId: a, taskId: "T1", step: "review", head: H, offeredAt: 1_000_000 });
    await hello("mate", { grant: null });
    expect(pushCandidates(db, now)).toEqual([]);
  });
});

describe("推送 TTL", () => {
  test("没确认：刚好 2 分钟不撤，过一毫秒撤（手挂的卡告诉 PM）；没 hello 过的 peer 的单不受影响", async () => {
    await hello();
    const a = await offer("T1");
    const old = await offer("T2", "old");
    now += PUSH_ACK_TTL_MS;
    await sweep();
    expect(status(a)).toBe("pooled");
    now += 1;
    expect(pushTtlDue(db, now).map((d) => d.orderId)).toEqual([a]);
    await sweep();
    expect(getLendOrder(db, a)).toMatchObject({ status: "cancelled", reason: expect.stringContaining("推送超时撤回") });
    expect(status(old)).toBe("pooled");
    expect(notices.join("\n")).toContain("没收到 mate 的确认");
  });

  test("确认了没领：从第一次确认起 3 分钟撤；重复确认不续命", async () => {
    await hello();
    const a = await offer("T1");
    now += 60_000;
    await ack([a]);
    now += 60_000;
    await ack([a]); // 重启后重推、对方又确认一次
    now += PUSH_CLAIM_TTL_MS - 60_000;
    await sweep();
    expect(status(a)).toBe("pooled");
    now += 1;
    await sweep();
    expect(status(a)).toBe("cancelled");
    expect(notices.join("\n")).toContain("确认收到后");
  });

  test("领走了的单 TTL 不碰；撤回之后对方再来领拿到 cancelled", async () => {
    await hello();
    const a = await offer("T1");
    const b = await offer("T2");
    expect((await call("claim", { v: 1, orderId: a, worker: "w1" })).ok).toBe(true);
    now += PUSH_CLAIM_TTL_MS + 1;
    await sweep();
    expect(status(a)).toBe("claimed");
    expect(status(b)).toBe("cancelled");
    expect(await call("claim", { v: 1, orderId: b, worker: "w2" })).toMatchObject({ ok: false, current: { lend: "cancelled" } });
  });

  test("auto 卡撤回不打扰 PM（调度器的池同步看到 cancelled 会重排）", async () => {
    await hello();
    const a = await offer("T1");
    db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES ('T1', '${P}', 'code', 2, 'auto', 'claude', '退回人工', 1, 1, 1)`);
    now += PUSH_ACK_TTL_MS + 1;
    await sweep();
    expect(status(a)).toBe("cancelled");
    expect(notices).toEqual([]);
  });

  test("撤回和 claim 两个进程同时抢同一单：只有一个赢，没有「撤了但对方也领到」", async () => {
    const mem = db;
    const path = join(mkdtempSync(join(tmpdir(), "lend-ttl-race-")), "ledger.sqlite");
    db = openLedger(path);
    try {
      setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
      await hello();
      const id = await offer("T1");
      const at = now + PUSH_ACK_TTL_MS + 1;
      const start = Date.now() + 1500;
      const lib = (f: string) => JSON.stringify(join(import.meta.dir, `../src/lib/${f}`));
      const script = (what: "claim" | "sweep") => `
        import { openLedger } from ${lib("ledger-store.ts")};
        import { claimLend, sweepLend } from ${lib("ledger-lend.ts")};
        const db = openLedger(${JSON.stringify(path)});
        while (Date.now() < ${start}) {}
        const ctx = { actor: "owner", now: ${at} };
        const borrow = () => ({ peer: "mate", projects: [${JSON.stringify(P)}], roles: ["review"], maxOpen: 3 });
        try {
          const r = ${what === "claim" ? `claimLend(db, ctx, "mate", { v: 1, orderId: ${JSON.stringify(id)}, worker: "w1" }, borrow)` : "sweepLend(db, ctx)"};
          console.log(JSON.stringify({ ok: true, lease: r.lease ?? null, n: Array.isArray(r) ? r.length : null }));
        } catch (e) { console.log(JSON.stringify({ ok: false, err: e.code ?? String(e), lend: e.current?.lend ?? null })); }`;
      const [claim, swept] = await Promise.all((["claim", "sweep"] as const).map(async (w) => {
        const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script(w)], { stdout: "pipe", stderr: "inherit" });
        return JSON.parse((await new Response(p.stdout).text()).trim()) as { ok: boolean; lease?: unknown; n?: number; lend?: string; err?: string };
      }));
      const [o] = listLendOrders(db, "T1");
      if (o!.status === "claimed") {
        expect(claim).toMatchObject({ ok: true, lease: expect.objectContaining({ gen: 1 }) });
        expect(swept!.n ?? 0).toBe(0);
      } else {
        expect(o!.status).toBe("cancelled");
        expect(claim!.ok).toBe(false);
        expect(["cancelled", null]).toContain(claim!.lend ?? null); // null = 等锁超时（busy），同样没领到
      }
      const claims = db.query("SELECT COUNT(*) AS n FROM events WHERE target = 'T1' AND json_extract(data, '$.lend.op') = 'claim'").get() as { n: number };
      expect(claims.n).toBe(o!.status === "claimed" ? 1 : 0);
    } finally {
      closeLedger(path);
      db = mem;
    }
  }, 30_000);
});

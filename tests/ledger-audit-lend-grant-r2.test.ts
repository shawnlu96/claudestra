/**
 * LGR1 第 2 轮审查复现：走正式 CLI（ledger audit --json → collectAuditSnapshots → auditLedger → reconcileFindings），pending 就是 ticker 要推的。
 * - first-run-silent：没有规则基线时，首轮就满足条件的授权提醒当轮就推（不能靠下一轮补——资格可能在 15 分钟里出窗）；
 * - grant-renotify：同一次授权（peer, until 不变）推过之后，哪怕中途因为出了 24 小时窗被关掉、又来了新单，也不再推第二次。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEND_GRANT_RULES } from "../src/lib/ledger-audit-lend-grant.js";
import type { SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings } from "../src/lib/ledger-audit-store.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const MIN = 60_000, HOUR = 60 * MIN, NOW = 20_000 * HOUR, PM = "agent-pm", P = "proj-x", PEER = "peer-alpha";
const SLOTS = JSON.stringify({ codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } });
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lgr1-r2-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

const setPeer = (until: number | null, helloAt: number) => {
  const grant = until === null ? null : JSON.stringify({ until, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 9 });
  db.prepare(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, NULL, 2, 'boot-1', 1, ?, ?, NULL, ?)
    ON CONFLICT(peer) DO UPDATE SET grant = excluded.grant, helloAt = excluded.helloAt`).run(PEER, grant, SLOTS, helloAt);
};
let n = 0;
const order = (at: number, status = "done") => db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step,
  specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'claude', 'write', 1, 0, 'h', 'o/r', 'w', 't', 's', ?, 1, 'scheduler', ?, ?)`)
  .run(`o${++n}`, `T${n}`, P, PEER, status, at, at);
const sources = (): SnapshotSources => ({ registry: async () => [], windows: async () => [], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json") });
/** 一轮正式巡检；返回这一轮推给 PM 的授权提醒（推完 ack，同 ticker） */
const cli = async (now: number) => {
  const r = await runLedger(["audit", "--json"], { db, actor: "owner", actorProject: P, projectIds: [P], now: () => now, auditSources: sources(),
    loadRegistry: async () => ({ agents: {} }), saveRegistry: async () => {} } as never) as { pending: { key: string; rule: string; notify: string }[] };
  const mine = r.pending.filter((f) => (LEND_GRANT_RULES as readonly string[]).includes(f.rule));
  ackFindings(db, mine.map((f) => f.key), now);
  return mine;
};
/** t = 0 / 15 / 30 / 45 分钟累计推了几条 */
const fourRounds = async (between?: (i: number) => void) => {
  const told: { rule: string }[] = [];
  const acc: number[] = [];
  for (let i = 0; i < 4; i++) {
    between?.(i);
    told.push(...(await cli(NOW + i * 15 * MIN)));
    acc.push(told.length);
  }
  return { acc, told };
};

describe("first-run-silent: no baseline, the only recent order is about to leave the 24 h window", () => {
  test("grant ends in 90 min, order 23h55m ago → told on the very first round, once", async () => {
    setPeer(NOW + 90 * MIN, NOW - MIN);
    order(NOW - 23 * HOUR - 55 * MIN);
    const { acc, told } = await fourRounds();
    expect(acc).toEqual([1, 1, 1, 1]);
    expect(told[0]).toMatchObject({ rule: "lend_grant_expiring", notify: PM });
  });
  test("grant null, hello 13 h ago, order 23h55m ago → 'gone' told on the very first round, once", async () => {
    setPeer(null, NOW - 13 * HOUR);
    order(NOW - 23 * HOUR - 55 * MIN);
    const { acc, told } = await fourRounds();
    expect(acc).toEqual([1, 1, 1, 1]);
    expect(told[0]).toMatchObject({ rule: "lend_grant_gone", notify: PM });
  });
  test("grant ends in 10 min → the 'expiring' notice is not lost to the first round", async () => {
    setPeer(NOW + 10 * MIN, NOW - MIN);
    order(NOW - HOUR);
    const first = await cli(NOW);
    expect(first.map((f) => f.rule)).toEqual(["lend_grant_expiring"]);
  });
  test("baseline row gets created once nothing is waiting to be told (old notices never silenced)", async () => {
    setPeer(NOW + 90 * MIN, NOW - MIN);
    order(NOW - HOUR);
    expect(await cli(NOW)).toHaveLength(1);
    setPeer(NOW + 30 * HOUR, NOW);
    expect(await cli(NOW + 15 * MIN)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_baseline WHERE project = ? AND rule LIKE 'lend_grant%'").get(P)).toEqual({ n: 2 });
  });
});

describe("grant-renotify: same (peer, until) told once for its whole life", () => {
  test("told, closed when the order left the window, a new order comes in with until unchanged → not told again", async () => {
    await cli(NOW - 10 * HOUR); // 预热基线
    setPeer(NOW + 90 * MIN, NOW - MIN);
    order(NOW - 23 * HOUR - 55 * MIN);
    const { acc } = await fourRounds((i) => {
      if (i === 2) { setPeer(NOW + 90 * MIN, NOW + 30 * MIN - MIN); order(NOW + 30 * MIN - 2 * MIN); }
    });
    expect(acc).toEqual([1, 1, 1, 1]);
  });
  test("same for 'gone': closed by a renewal that is later withdrawn with the same last hello → not told again", async () => {
    await cli(NOW - 10 * HOUR);
    setPeer(null, NOW - 13 * HOUR);
    order(NOW - HOUR);
    const { acc } = await fourRounds((i) => {
      if (i === 1) setPeer(NOW + 30 * HOUR, NOW - 13 * HOUR);
      if (i === 2) setPeer(null, NOW - 13 * HOUR);
    });
    expect(acc).toEqual([1, 1, 1, 1]);
  });
  test("a renewed grant (until changed) is still told again", async () => {
    await cli(NOW - 10 * HOUR);
    setPeer(NOW + 90 * MIN, NOW - MIN);
    order(NOW - HOUR);
    const { acc } = await fourRounds((i) => { if (i === 2) setPeer(NOW + 100 * MIN, NOW + 29 * MIN); });
    expect(acc).toEqual([1, 1, 2, 2]);
  });
});

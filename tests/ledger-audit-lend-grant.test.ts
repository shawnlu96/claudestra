/**
 * LGR1：出借授权快到期（≤ 2 小时）提醒一次、授权没了（grant null / until 过了）提醒一次，只看最近 24 小时在本项目有过出借单的 peer；
 * 按 (peer, until) / (peer, hello 时间或 until) 去重，续了授权算新的一次。lend-peers 多出 grantUntil / grantState，why 原样不动。
 * 用真实台账 schema 的临时台账（openLedger）走 readLendGrants → auditLedger → reconcileFindings。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { grantUntilOf, LEND_GRANT_RULES, localTime } from "../src/lib/ledger-audit-lend-grant.js";
import { readLendGrantBaseline, readLendGrants, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const MIN = 60_000, HOUR = 60 * MIN, NOW = 20_000 * HOUR, PM = "agent-pm", P = "proj-x", PEER = "peer-alpha";
const SLOTS = JSON.stringify({ codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } });
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lgr1-audit-"));
  db = openLedger(join(dir, "ledger.sqlite"));
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

const setPeer = (until: number | null, helloAt = NOW - MIN, peer = PEER) => {
  const grant = until === null ? null : JSON.stringify({ until, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 9 });
  db.prepare(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, NULL, 2, 'boot-1', 1, ?, ?, NULL, ?)
    ON CONFLICT(peer) DO UPDATE SET grant = excluded.grant, helloAt = excluded.helloAt`).run(peer, grant, SLOTS, helloAt);
};
let n = 0;
const order = (at: number, status = "claimed", project = P, peer = PEER) => db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step,
  specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'claude', 'write', 1, 0, 'h', 'o/r', 'w', 't', 's', ?, 1, 'scheduler', ?, ?)`)
  .run(`o${++n}`, `T${n}`, project, peer, status, at, at);

const snap = (now: number, lendGrantBaseline: readonly string[] | null = readLendGrantBaseline(db, P)): AuditSnapshot => ({ project: P, pms: [PM], tasks: [],
  agents: [], reviewers: [], held: [], ownerInbox: [], lendGrants: readLendGrants(db, P, now), lendGrantBaseline } as AuditSnapshot);
/** 纯规则：基线按已建好算 */
const grantFindings = (now: number) => auditLedger(snap(now, LEND_GRANT_RULES), now).findings.filter((f) => (LEND_GRANT_RULES as readonly string[]).includes(f.rule));
/** 一轮巡检落库，返回这一轮要推的（推完 ack，同 bridge 的推送路径） */
const round = (now: number) => {
  const r = auditLedger(snap(now), now);
  const pending = reconcileFindings(db, P, r.findings, r.evaluated, now).pending.filter((f) => (LEND_GRANT_RULES as readonly string[]).includes(f.rule));
  ackFindings(db, pending.map((f) => f.key), now);
  return pending;
};
/** 上线首轮：规则基线静默，之后新出现的才推 */
const baseline = () => round(NOW - 10 * HOUR);

/** 审查 first-run-silent：不预热基线，走正式 CLI（ledger audit --json → collectAuditSnapshots → auditLedger → reconcileFindings），pending 就是 ticker 要推的 */
describe("first run is not silenced (no pre-built baseline)", () => {
  const sources = (): SnapshotSources => ({ registry: async () => [], windows: async () => [], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json") });
  const cli = async (now: number) => {
    const r = await runLedger(["audit", "--json"], { db, actor: "owner", actorProject: P, projectIds: [P], now: () => now, auditSources: sources(),
      loadRegistry: async () => ({ agents: {} }), saveRegistry: async () => {} } as never) as { pending: { key: string; rule: string; notify: string }[] };
    const mine = r.pending.filter((f) => (LEND_GRANT_RULES as readonly string[]).includes(f.rule));
    ackFindings(db, mine.map((f) => f.key), now);
    return mine;
  };
  const cases: [string, () => void, string][] = [
    ["grant ends in 1.5 h", () => setPeer(NOW + 90 * MIN), "lend_grant_expiring"],
    ["grant null, last hello 13 h ago", () => setPeer(null, NOW - 13 * HOUR), "lend_grant_gone"],
    ["until passed an hour ago", () => setPeer(NOW - HOUR, NOW - 30 * MIN), "lend_grant_gone"],
  ];
  for (const [name, seed, rule] of cases) {
    test(`${name} on a ledger that never ran these rules → told once (one round later), not silenced`, async () => {
      setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
      seed();
      order(NOW - 14 * HOUR, "done");
      expect(await cli(NOW)).toEqual([]); // 这一轮只建基线，不出发现（也就没东西可被静默）
      expect(db.query("SELECT COUNT(*) AS n FROM audit_findings WHERE rule LIKE 'lend_grant%'").get()).toEqual({ n: 0 });
      const told = await cli(NOW + 15 * MIN);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ rule, notify: PM });
      expect(await cli(NOW + 30 * MIN)).toEqual([]);
    });
  }
  test("baseline unreadable → rules neither run nor evaluated (nothing gets silenced)", () => {
    setPeer(NOW + 90 * MIN);
    order(NOW - HOUR);
    const r = auditLedger(snap(NOW, null), NOW);
    expect(r.evaluated).not.toContain("lend_grant_expiring");
    expect(r.findings.filter((f) => f.rule.startsWith("lend_grant"))).toEqual([]);
  });
});

describe("lend_grant_expiring", () => {
  test("grant ends in 1.5 h + a recent lend order → one notice to the PM; a second round does not repeat", () => {
    baseline();
    setPeer(NOW + 90 * MIN);
    order(NOW - 2 * HOUR);
    const first = round(NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ rule: "lend_grant_expiring", notify: PM, suggestion: "请对方 owner 续授权" });
    expect(first[0]!.detail).toContain(PEER);
    expect(first[0]!.detail).toContain(localTime(NOW + 90 * MIN));
    expect(first[0]!.detail).toContain("当前在跑 1 单");
    expect(round(NOW + 5 * MIN)).toEqual([]);
  });
  test("grant ends in 3 h → quiet", () => {
    setPeer(NOW + 3 * HOUR);
    order(NOW - HOUR);
    expect(grantFindings(NOW)).toEqual([]);
  });
  test("ends in 1.5 h but no lend order in this project in 24 h → quiet (another project's order does not count)", () => {
    setPeer(NOW + 90 * MIN);
    order(NOW - 25 * HOUR, "done");
    order(NOW - HOUR, "claimed", "other-proj");
    expect(grantFindings(NOW)).toEqual([]);
  });
  test("a renewed grant (until changed) counts as a new one and is told again", () => {
    baseline();
    setPeer(NOW + 90 * MIN);
    order(NOW - HOUR);
    expect(round(NOW)).toHaveLength(1);
    setPeer(NOW + 24 * HOUR + 60 * MIN);
    expect(round(NOW + MIN)).toEqual([]); // renewed far out: nothing to tell
    order(NOW + 20 * HOUR);
    const again = round(NOW + 24 * HOUR); // the renewed grant now ends in 1 h
    expect(again).toHaveLength(1);
    expect(again[0]!.key).toContain(String(NOW + 24 * HOUR + 60 * MIN));
  });
});

describe("lend_grant_gone", () => {
  test("grant null, last hello 13 h ago + a recent lend order → one 'expired / revoked' notice, not repeated", () => {
    baseline();
    setPeer(null, NOW - 13 * HOUR);
    order(NOW - 14 * HOUR, "done");
    const f = round(NOW);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "lend_grant_gone", notify: PM });
    expect(f[0]!.detail).toContain(`peer ${PEER} 的出借授权已到期 / 已收回（${localTime(NOW - 13 * HOUR)}），调度器不会再往它派单`);
    expect(round(NOW + 10 * MIN)).toEqual([]);
  });
  test("until already passed → 'expired' keyed by until; a renewal clears it", () => {
    baseline();
    setPeer(NOW - HOUR, NOW - 30 * MIN);
    order(NOW - 3 * HOUR);
    const f = round(NOW);
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe(`${P}|lend_grant_gone|${PEER}|${NOW - HOUR}`);
    setPeer(NOW + 10 * HOUR);
    expect(grantFindings(NOW + MIN)).toEqual([]);
  });
  test("no lend tables → rule not run, not evaluated", () => {
    const r = auditLedger({ project: P, pms: [PM], tasks: [], agents: [], reviewers: [], held: [], ownerInbox: [] }, NOW);
    expect(r.evaluated).not.toContain("lend_grant_gone");
  });
  test("grant JSON parsing: missing / broken / no until → no grant", () => {
    expect(grantUntilOf(null)).toBeNull();
    expect(grantUntilOf("{bad")).toBeNull();
    expect(grantUntilOf("{}")).toBeNull();
    expect(grantUntilOf(JSON.stringify({ until: 5 }))).toBe(5);
  });
});

describe("lend-peers shows grantUntil / grantState; why is unchanged", () => {
  const peers = async (now: number) => {
    const deps = { db, actor: PM, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
      lend: { borrow: async () => [{ peer: PEER, maxOpen: 2 }], notifyPm: async () => {} } };
    const r = (await runLedger(["lend-peers"], deps as never)) as { peers?: Record<string, unknown>[] };
    expect(r.peers).toBeDefined();
    return r.peers![0]!;
  };
  test("live / expired / none", async () => {
    setPeer(NOW + HOUR, NOW - MIN);
    expect(await peers(NOW)).toMatchObject({ peer: PEER, grantUntil: NOW + HOUR, grantState: "live" });
    setPeer(NOW - HOUR, NOW - 13 * HOUR);
    const expired = await peers(NOW);
    expect(expired).toMatchObject({ grantUntil: NOW - HOUR, grantState: "expired" });
    expect(expired.why).toContain("180");
    setPeer(null, NOW - 13 * HOUR);
    expect(await peers(NOW)).toMatchObject({ grantUntil: null, grantState: "none", why: expired.why });
  });
});

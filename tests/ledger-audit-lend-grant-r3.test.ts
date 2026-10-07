/**
 * LGR1 第 3 轮审查复现（stale-grant-pending）：走正式 CLI（ledger audit --json → collectAuditSnapshots → auditLedger → reconcileFindings）。
 * 没有规则基线、PM 首轮离线没推出去；之后一个 peer 续了授权、另一个还没——PM 上线这轮只推仍没授权的那个，续了的那条随后关掉，不推过时的「已到期」。
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

const MIN = 60_000, HOUR = 60 * MIN, NOW = 20_000 * HOUR, PM = "agent-pm", P = "proj-x", A = "peer-alpha", B = "peer-beta";
const SLOTS = JSON.stringify({ codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } });
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lgr1-r3-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

const setPeer = (peer: string, until: number | null, helloAt: number) => {
  const grant = until === null ? null : JSON.stringify({ until, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 9 });
  db.prepare(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, NULL, 2, 'boot-1', 1, ?, ?, NULL, ?)
    ON CONFLICT(peer) DO UPDATE SET grant = excluded.grant, helloAt = excluded.helloAt`).run(peer, grant, SLOTS, helloAt);
};
let n = 0;
const order = (peer: string, at: number) => db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step,
  specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, 'claude', 'write', 1, 0, 'h', 'o/r', 'w', 't', 's', 'done', 1, 'scheduler', ?, ?)`)
  .run(`o${++n}`, `T${n}`, P, peer, at, at);
const sources = (): SnapshotSources => ({ registry: async () => [], windows: async () => [], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json") });
/** 一轮正式巡检；online = PM 在线（推完 ack，同 ticker），离线就不 ack */
const cli = async (now: number, online: boolean) => {
  const r = await runLedger(["audit", "--json"], { db, actor: "owner", actorProject: P, projectIds: [P], now: () => now, auditSources: sources(),
    loadRegistry: async () => ({ agents: {} }), saveRegistry: async () => {} } as never) as { pending: { key: string; rule: string; notify: string }[] };
  const mine = r.pending.filter((f) => (LEND_GRANT_RULES as readonly string[]).includes(f.rule));
  if (online) ackFindings(db, mine.map((f) => f.key), now);
  return mine.map((f) => f.key);
};
const resolvedAt = (peer: string) =>
  (db.query("SELECT resolvedAt FROM audit_findings WHERE project = ? AND key LIKE ?").get(P, `${P}|lend_grant_gone|${peer}|%`) as { resolvedAt: number | null }).resolvedAt;

describe("stale-grant-pending: no baseline, PM offline on round 1, one of two peers renewed before PM is back", () => {
  test("PM back → only the still-gone peer is told; the renewed peer's old finding is never pushed and gets closed", async () => {
    setPeer(A, null, NOW - 13 * HOUR);
    setPeer(B, null, NOW - 13 * HOUR);
    order(A, NOW - HOUR);
    order(B, NOW - HOUR);
    expect(await cli(NOW, false)).toHaveLength(2);
    setPeer(A, NOW + 30 * HOUR, NOW + 15 * MIN);
    const back = await cli(NOW + 15 * MIN, true);
    expect(back).toHaveLength(1);
    expect(back[0]).toStartWith(`${P}|lend_grant_gone|${B}|`);
    expect(await cli(NOW + 30 * MIN, true)).toEqual([]);
    expect(resolvedAt(A)).toBe(NOW + 30 * MIN);
    expect(resolvedAt(B)).toBeNull();
    expect(await cli(NOW + 45 * MIN, true)).toEqual([]);
  });
  test("a new peer going gone after the baseline exists is still told", async () => {
    setPeer(A, null, NOW - 13 * HOUR);
    setPeer(B, NOW + 30 * HOUR, NOW);
    order(A, NOW - HOUR);
    order(B, NOW - HOUR);
    expect(await cli(NOW, true)).toHaveLength(1);
    await cli(NOW + 15 * MIN, true); // A 已推过 → 建基线
    setPeer(B, null, NOW + 20 * MIN);
    const next = await cli(NOW + 30 * MIN, true);
    expect(next).toHaveLength(1);
    expect(next[0]).toStartWith(`${P}|lend_grant_gone|${B}|`);
  });
});

/** REBOR2 in-memory canonical ledger: real offer/claim/release/cancel/endWriteLease paths produce each ended lease. */
import type { Database } from "bun:sqlite";
import { openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { cancelLend, claimLend, getLendOrder, leaseLend, offerLend, reclaimLend } from "../src/lib/ledger-lend.js";
import { endWriteLease } from "../src/lib/ledger-lend-lease.js";
import { beatLend, recordHello } from "../src/lib/ledger-lend-peers.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { mustTask } from "../src/lib/ledger-checks.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { Reborrow2Remote, Reborrow2SourceProbe } from "../src/lib/lend-reborrow2-source.js";

const project = "p";
export const taskId = "RB2", peer = "mate", other = "pal", repo = "owner/repo";
export const fp = "abcd-ef01-2345-6789", fp2 = "1234-5678-9abc-def0";
export const base = "a".repeat(40), pushed = "c".repeat(40);
export const now = 100_000;
export const pm = { actor: "agent-pm", now };
export const borrowOf = (p: string): BorrowEntry => ({ peer: p, projects: [project], roles: ["write"], maxOpen: 4 });
/** revokedWorking / revokedStarting: the canonical clean-revocation beat (ledger-lend-peers.ts endOrder) also records not_started. */
export type EndKind = "checkout" | "push" | "model400" | "reclaim" | "revokedWorking" | "revokedStarting";

function hello(db: Database, p: string, f: string, at = now) {
  recordHello(db, p, f, { v: 1, proto: 3, boot: `${p}-boot`, seq: at, paused: null,
    grant: { until: at + 1_000_000, repos: [repo], roles: ["write"], ordersPerDay: 10, ordersLeftToday: 10 },
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } } }, at);
}

/** One original write order on `peer`, claimed (gen 1), then ended through the canonical path named by `end`. */
export function setupLedger(end: EndKind) {
  const db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1 }, { project, key: "pms", value: [pm.actor] });
  createTask(db, { actor: "owner", now: 2 }, { project, id: taskId, title: "Recovery", kind: "code" });
  db.run("INSERT OR REPLACE INTO scheduler_meta (key, value) VALUES ('activationSeq', '0')");
  switchFamily(db, "codex", 4);
  db.run("UPDATE tasks SET stage = 'build' WHERE id = ?", [taskId]);
  hello(db, peer, fp, 10);
  const o = offerLend(db, { ...pm, now: 20 }, { taskId, peer, repo, family: "codex", pr: null, spec: "Keep original P0/P1",
    borrow: borrowOf(peer), write: { fp, base: "main", baseSha: base, report: null } });
  claimLend(db, { actor: "owner", now: 30 }, peer, { v: 1, orderId: o.orderId, worker: "w" }, () => borrowOf(peer));
  if (end === "checkout") leaseLend(db, { actor: "owner", now: 40 }, peer, { v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "not_started", detail: "checkout 未启动" });
  if (end === "push" || end === "model400") {
    const detail = end === "push" ? "推送超时" : "模型配置 400";
    leaseLend(db, { actor: "owner", now: 40 }, peer, { v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "stopped", detail });
    cancelLend(db, { ...pm, now: 45 }, { taskId, reason: `PM 结清：${detail}` });
    endWriteLease(db, taskId, `派不回去：${detail}`, 50);
  }
  if (end === "revokedWorking" || end === "revokedStarting") {
    beatLend(db, { actor: "owner", now: 40 }, peer, { v: 1, orders: [{ orderId: o.orderId, gen: 1, phase: end === "revokedWorking" ? "working" : "starting",
      lastActivityAt: 39, excerpt: "", ended: { reason: "revoked", clean: true } }] }, new Map([[o.orderId, "clean" as const]]));
  }
  if (end === "reclaim") reclaimLend(db, { ...pm, now: 50 }, { taskId, reason: "PM reclaim" });
  for (const [p, f] of [[peer, fp], [other, fp2]] as const) hello(db, p, f);
  return { db, oldId: o.orderId, old: () => getLendOrder(db, o.orderId)! };
}

/** The formal family epoch: a real PM's manual workflow write (setWorkflow), never a hand-made label. */
export function switchFamily(db: Database, family: "codex" | "claude", at: number, actor = pm.actor) {
  const w = getWorkflow(db, taskId);
  return setWorkflow(db, { actor, now: at }, { taskId, template: "code", templateVersion: 2, mode: "manual", authorFamily: family,
    fallback: "local", taskRev: mustTask(db, taskId).rev, workflowRev: w?.rev ?? 0 } as never);
}

export const rows = (db: Database) => JSON.stringify([db.query("SELECT * FROM tasks").all(), db.query("SELECT * FROM lend_write_leases").all(),
  db.query("SELECT * FROM lend_orders").all(), db.query("SELECT * FROM events").all()]);

/** Fake remote: per-branch head / PR; a missing key = unreadable. */
export function fakeProbe(remotes: Record<string, Reborrow2Remote | null>, opts: { fp?: Record<string, string | null>; ancestor?: boolean | null } = {}) {
  const reads: string[] = [];
  const probe: Reborrow2SourceProbe = {
    peerFp: async (p) => (opts.fp ? opts.fp[p] ?? null : p === peer ? fp : fp2),
    remote: async (_p, r, b) => { reads.push(b); return b in remotes ? structuredClone(remotes[b]) : null; },
    isAncestor: async () => (opts.ancestor === undefined ? true : opts.ancestor),
  };
  return { probe, reads, remotes };
}

export const absent = (branch: string): Reborrow2Remote => ({ repo, branch, head: null, pr: null });
export const at = (branch: string, head: string): Reborrow2Remote => ({ repo, branch, head, pr: null });

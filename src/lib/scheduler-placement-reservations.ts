/** Prepared writes are durable task facts, never registry/name guesses or writes from a placement read. */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { HELLO_FRESH_MS, type Grant, type Paused, type Slots } from "./lend-wire-v2.js";
import { cooldownPeerSlots } from "./lend-peer-cooldown.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-config.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";

export interface PlacementReservation {
  mode: "on" | "observe";
  family: AuthorFamily;
  /** null denotes the unified pool, where the retired maxOpen knob does not apply. */
  maxOpen: number | null;
}
export interface ReservationRead { exceptTask?: string; observe?: boolean; enforce?: boolean }
export interface ReservationPort {
  mode: "on" | "observe" | "off";
  observe?(result: { actual: string; proposed: string }): void;
}

/** The internal CLI transports the typed receipt as JSON; malformed receipts cannot activate a hold. */
export function parsePlacementReservation(raw: string | undefined): PlacementReservation | null {
  if (raw === undefined) return null;
  let r: PlacementReservation;
  try { r = JSON.parse(raw); } catch { throw new LedgerError("invalid", "reservation 必须是 JSON"); }
  if (!r || !["on", "observe"].includes(r.mode) || !["claude", "codex"].includes(r.family) ||
    (r.maxOpen !== null && (!Number.isInteger(r.maxOpen) || r.maxOpen < 0))) throw new LedgerError("invalid", "reservation 字段不合法");
  return { mode: r.mode, family: r.family, maxOpen: r.maxOpen };
}

/** An order supersedes its preparation even after withdrawal: cancellation must not resurrect an old hold. */
export function preparedPeerWrites(db: Database, peer: string, read: ReservationRead = {}) {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lend_orders'").get()) {
    return { total: 0, families: { claude: 0, codex: 0 }, managed: false };
  }
  const managed = !!db.query(`SELECT 1 FROM lend_orders o JOIN tasks t ON t.id=o.taskId
    WHERE o.peer=? AND o.status IN ('pooled','claimed','unknown') AND json_extract(t.extra, '$.placementReservation.mode')='on' LIMIT 1`).get(peer);
  const rows = db.query(`SELECT json_extract(t.extra, '$.placementReservation.family') AS family FROM tasks t
    WHERE json_extract(t.extra, '$.placement') = ? AND t.id != ? AND t.kind='code'
    AND t.stage IN ('spec','restate','build','fix')
    AND (json_extract(t.extra, '$.placementReservation.mode')='on'
      OR (? AND json_extract(t.extra, '$.placementReservation.mode')='observe'))
    AND NOT EXISTS (SELECT 1 FROM lend_orders o WHERE o.taskId=t.id AND o.specRev=t.specRev AND o.step IN ('write','fix'))`)
    .all(`peer:${peer}`, read.exceptTask ?? "", read.observe ? 1 : 0) as { family: string }[];
  const families = { claude: 0, codex: 0 };
  for (const row of rows) {
    if (row.family === "claude" || row.family === "codex") families[row.family]++;
    else { families.claude++; families.codex++; } // A malformed persisted hold cannot manufacture free family capacity.
  }
  return { total: rows.length, families, managed };
}

/** Called inside createTask's immediate transaction, after replay detection and before any insertion. */
function checkPreparedPlacement(db: Database, task: { project: string; extra?: Record<string, unknown> },
  capacity: (peer: string, maxOpen: number | null) => { why: string | null; slots: Record<AuthorFamily, number>; grant: Grant | null }): void {
  const extra = task.extra;
  const r = extra?.placementReservation as PlacementReservation | undefined;
  if (!r || r.mode !== "on") return;
  if (!extra || typeof extra.placement !== "string" || !extra.placement.startsWith("peer:") ||
    !["claude", "codex"].includes(r.family) || (r.maxOpen !== null && (!Number.isInteger(r.maxOpen) || r.maxOpen < 0))) {
    throw new LedgerError("invalid", "准备放置缺少有效 peer / family / capacity");
  }
  if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("busy", "项目队列已冻结");
  const cap = capacity(extra.placement.slice(5), r.maxOpen);
  if (cap.why || cap.slots[r.family] <= 0) throw new LedgerError("busy", `准备放置已无余量：${cap.why ?? r.family}`);
  if (typeof extra.repo !== "string" || !cap.grant?.repos.some((repo) => repo.toLowerCase() === (extra.repo as string).toLowerCase()) ||
    (r.maxOpen !== null && !cap.grant.roles.includes("write"))) throw new LedgerError("busy", "准备放置的仓库或写授权已失效");
}

export interface LendPeer { peer: string; fp: string | null; proto: number; boot: string; seq: number; grant: Grant | null; slots: Slots; paused: Paused | null; helloAt: number }

export const hasPeersTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_peers'").get();

export function getLendPeer(db: Database, peer: string): LendPeer | null {
  if (!hasPeersTable(db)) return null;
  const r = db.query("SELECT * FROM lend_peers WHERE peer = ?").get(peer) as Record<string, unknown> | null;
  if (!r) return null;
  const json = <T>(v: unknown): T | null => (typeof v === "string" ? JSON.parse(v) as T : null);
  return { ...(r as unknown as LendPeer), grant: json<Grant>(r.grant), slots: json<Slots>(r.slots) as Slots, paused: json<Paused>(r.paused) };
}

export interface PeerCapacity { peer: string; proto: number; helloAt: number | null; open: number; slots: Record<LendFamily, number>; why: string | null }

/** The caller owns the write transaction; the shared capacity reader is re-run before recording a preparation. */
export function checkPreparedPeerPlacement(db: Database, task: { id?: string; project: string; extra?: Record<string, unknown> }, now: number): void {
  checkPreparedPlacement(db, task, (peer, maxOpen) => {
    const read = { exceptTask: task.id, enforce: true };
    const cap = maxOpen === null ? unifiedPeerCapacity(db, peer, now, read) : peerCapacity(db, peer, maxOpen, now, read);
    return { ...cap, slots: cooldownPeerSlots(db, peer, cap.slots, now), grant: getLendPeer(db, peer)?.grant ?? null };
  });
}

const zero = (): Record<LendFamily, number> => ({ codex: 0, claude: 0 });

/** Orders A has out with this peer that still hold a place there (pooled, claimed, or stopped for PM). */
const liveOrdersAt = (db: Database, peer: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND status IN (${LEND_LIVE.map(() => "?").join(",")})`).get(peer, ...LEND_LIVE) as { n: number }).n;

/** A family paused for its own quota stops only that family; any other pause stops the peer. */
const pausedFamily = (p: Paused | null, f: LendFamily, now: number): boolean => !!p && p.until > now && (p.reason === `${f}_quota` || !p.reason.endsWith("_quota"));

/**
 * What the scheduler may place on this peer per family now. Zero when there is no hello (proto 1), the hello is older than
 * HELLO_FRESH_MS, the grant is gone, expired or used up for today; otherwise the reported free slots, capped by the room
 * borrow.maxOpen leaves after A's own live orders there (null = no maxOpen cap: the unified pool, see unifiedPeerCapacity).
 */
export function peerCapacity(db: Database, peer: string, maxOpen: number | null, now: number, read: ReservationRead = {}): PeerCapacity {
  const p = getLendPeer(db, peer);
  const prepared = preparedPeerWrites(db, peer, read);
  const open = liveOrdersAt(db, peer) + prepared.total;
  const base = { peer, proto: p?.proto ?? 1, helloAt: p?.helloAt ?? null, open, slots: zero() };
  if (!p) return { ...base, why: "没有 hello（按 proto 1，只轮询）" };
  if (now - p.helloAt > HELLO_FRESH_MS) return { ...base, why: `hello 超过 ${HELLO_FRESH_MS / 1000} 秒没更新` };
  if (!p.grant) return { ...base, why: "对方没有授权（或已收回）" };
  if (p.grant.until <= now) return { ...base, why: "对方的授权已到期" };
  if (p.grant.ordersLeftToday <= 0) return { ...base, why: "对方今天的单数用完了" };
  const room = maxOpen === null ? Infinity : Math.max(0, maxOpen - open);
  const slots = zero();
  for (const f of LEND_FAMILIES) {
    const live = (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer=? AND family=? AND status IN ('pooled','claimed','unknown')`)
      .get(peer, f) as { n: number }).n;
    const managed = maxOpen === null || read.enforce || read.observe || prepared.total > 0 || prepared.managed;
    const busy = managed ? Math.max(p.slots[f].busy, live) : p.slots[f].busy;
    slots[f] = pausedFamily(p.paused, f, now) ? 0 : Math.min(room, Math.max(0, p.slots[f].total - busy - prepared.families[f]));
  }
  return { ...base, slots, why: null };
}

export interface UnifiedPeerCapacity extends PeerCapacity { totals: Record<LendFamily, number>; busy: Record<LendFamily, number> }

/**
 * The unified agent pool's view of a peer, shared by placement and every capacity reading: borrow.maxOpen does not apply;
 * each family is min(reported free, reported total − A's live orders of that family there, across all projects), so two
 * projects borrowing the same peer see one set of seats. busy is taken before cooldown (placement load); slots after it.
 * tests/lend-capacity-parity.test.ts.
 */
export function unifiedPeerCapacity(db: Database, peer: string, now: number, read: ReservationRead = {}): UnifiedPeerCapacity {
  const cap = peerCapacity(db, peer, null, now, read);
  const p = getLendPeer(db, peer);
  const slots = { ...cap.slots }, totals = zero(), busy = zero();
  for (const f of LEND_FAMILIES) {
    totals[f] = p?.slots[f].total ?? 0;
    const live = (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND status IN (${LEND_LIVE.map(() => "?").join(",")})`)
      .get(peer, f, ...LEND_LIVE) as { n: number }).n;
    slots[f] = Math.min(slots[f], Math.max(0, totals[f] - live));
    busy[f] = totals[f] - slots[f];
  }
  return { ...cap, slots: cooldownPeerSlots(db, peer, slots, now), totals, busy };
}

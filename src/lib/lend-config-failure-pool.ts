/**
 * Provider model-config failure (dispatch-recovery-LCFG1), borrower (A) side. A peer's family is unavailable while A's
 * ledger holds a not_started release whose start error is the model-not-enabled class (lend-config-failure.ts) newer than
 * that peer + family's last explicit recovery. The evidence is the append-only release note itself (seq, time, order, text),
 * so nothing is copied and nothing expires with time.
 * - Placement: under on, configFailureV2 zeroes that family's slots on that peer before the planner sees them; other families
 *   and peers are untouched, live orders are never touched. observe / off return the facts unchanged (configFailureView
 *   shows the would-be pause). No notice is raised on A.
 * - Recovery only from the lender's explicit declaration (hello configRecovered: the owner recovered fault generation gen,
 *   covering these orders), never a restart, slots going back up, a mode switch or elapsed time. Under on only, inside
 *   recordHello's transaction; it records `through` = the newest event seq, CAS on the record; a later failure has a higher
 *   seq and an order no old declaration names.
 * tests/lend-config-failure*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { LEND_FAMILIES, type LendFamily } from "./lend-config.js";
import type { HelloRequest } from "./lend-wire-v2.js";
import type { LendPeer } from "./scheduler-placement-reservations.js";
import type { PeerFacts } from "./scheduler-placement.js";
import { CONFIG_FAILURE_CATEGORY, classifyConfigFailure, configFailureMode, type ConfigFailureMode } from "./lend-config-failure.js";

/** The not_started detail lend-drive.ts sends for a failed worker create. */
const START_FAILURE = "起 worker 失败：";

export interface PeerConfigFailure { seq: number; at: number; orderId: string; family: LendFamily; category: typeof CONFIG_FAILURE_CATEGORY; text: string }
/** gen = the lender's declared fault generation last accepted; through = newest event seq then; order = the fault order it covered. */
interface Recovery { gen: number; through: number; boot: string; at: number; order: string }

const recoveryKey = (peer: string, family: LendFamily): string => `lend:config-recovery:${JSON.stringify([peer, family])}`;

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
function metaRaw(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE project = 'master' AND key = ?").get(key) as { value: string } | null)?.value ?? null;
}
function readRecovery(db: Database, peer: string, family: LendFamily): { raw: string | null; r: Recovery | null } {
  const raw = metaRaw(db, recoveryKey(peer, family));
  try { return { raw, r: raw ? (JSON.parse(raw) as Recovery) : null }; } catch { return { raw, r: null }; }
}

/** Per family, the newest configuration-class start failure of this peer after its last recovery. */
export function activeConfigFailures(db: Database, peer: string): Partial<Record<LendFamily, PeerConfigFailure>> {
  const out: Partial<Record<LendFamily, PeerConfigFailure>> = {};
  if (!hasTable(db, "lend_orders")) return out;
  const q = db.query(`SELECT e.seq, e.ts, e.text, o.orderId FROM events AS e JOIN lend_orders AS o ON o.orderId = json_extract(e.data, '$.lend.orderId')
    WHERE e.kind = 'note' AND json_extract(e.data, '$.lend.op') = 'release' AND json_extract(e.data, '$.lend.reason') = 'not_started'
    AND json_extract(e.data, '$.lend.peer') = ? AND o.peer = ? AND o.family = ? AND e.seq > ? ORDER BY e.seq DESC`);
  for (const family of LEND_FAMILIES) {
    const through = readRecovery(db, peer, family).r?.through ?? 0;
    for (const r of q.all(peer, peer, family, through) as { seq: number; ts: number; text: string; orderId: string }[]) {
      const at = r.text.indexOf(START_FAILURE);
      if (at < 0 || !classifyConfigFailure(r.text.slice(at + START_FAILURE.length))) continue;
      out[family] = { seq: r.seq, at: r.ts, orderId: r.orderId, family, category: CONFIG_FAILURE_CATEGORY, text: r.text };
      break;
    }
  }
  return out;
}

/** What the mechanism sees for one peer: per failing family, whether on would pause it and whether it does now. */
export function configFailureView(db: Database, peer: string): { mode: ConfigFailureMode; families: { family: LendFamily; failure: PeerConfigFailure; paused: boolean }[] } {
  const mode = configFailureMode();
  const active = mode === "off" ? {} : activeConfigFailures(db, peer);
  return { mode, families: Object.values(active).map((failure) => ({ family: failure.family, failure, paused: mode === "on" })) };
}

/** Placement filter on a peer's v2 facts: under on, families with an active configuration fault get zero slots. */
export function configFailureV2(db: Database, peer: string, v2: PeerFacts["v2"]): PeerFacts["v2"] {
  if (!v2 || configFailureMode() !== "on") return v2;
  const active = activeConfigFailures(db, peer);
  const down = LEND_FAMILIES.filter((f) => active[f] && v2.slots[f] > 0);
  if (!down.length) return v2;
  return { ...v2, slots: { ...v2.slots, ...Object.fromEntries(down.map((f) => [f, 0])) } };
}

/**
 * Inside recordHello's transaction, after the hello was applied; only under on (observe / off write nothing). Recovery only
 * from the lender's explicit declaration (hello configRecovered, sent by B only after its owner's recoverProviderConfigFailure
 * succeeded): for the same peer + family, the declared fault generation must be above the one last accepted (persisted here;
 * an older or repeated generation is refused) and its evidence orders must include this family's newest fault order. So a
 * restart, a mode switch on B, a capacity change or a replayed old hello (whatever its seq or boot) never recovers, and an old
 * declaration never clears a newer fault (a later failure's order is not in it). CAS on the record.
 */
export function recoverOnRedeclare(db: Database, peer: string, _prev: LendPeer | null, req: HelloRequest, now: number): void {
  if (configFailureMode() !== "on" || !req.configRecovered) return;
  const active = activeConfigFailures(db, peer);
  for (const family of LEND_FAMILIES) {
    const fault = active[family], decl = req.configRecovered[family];
    if (!fault || !decl) continue;
    const { raw, r } = readRecovery(db, peer, family);
    if (decl.gen <= (r?.gen ?? 0) || !decl.orders.includes(fault.orderId)) continue;
    const top = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number | null }).s ?? 0;
    recoverCas(db, peer, family, raw, { gen: decl.gen, through: top, boot: req.boot, at: now, order: fault.orderId });
  }
}

/** Replace the recovery record only if it is still exactly `expected` (null = absent). */
function recoverCas(db: Database, peer: string, family: LendFamily, expected: string | null, next: Recovery): boolean {
  const value = JSON.stringify(next);
  const r = expected === null
    ? db.run("INSERT INTO meta (project, key, value) VALUES ('master', ?, ?) ON CONFLICT(project, key) DO NOTHING", [recoveryKey(peer, family), value])
    : db.run("UPDATE meta SET value = ? WHERE project = 'master' AND key = ? AND value = ?", [value, recoveryKey(peer, family), expected]);
  return r.changes === 1;
}

/** The lender's fault generation last accepted as recovered (0 = never recovered). */
export const configRecoveryGen = (db: Database, peer: string, family: LendFamily): number => readRecovery(db, peer, family).r?.gen ?? 0;

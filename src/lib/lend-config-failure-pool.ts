/**
 * Provider model-config failure (dispatch-recovery-LCFG1), borrower (A) side. A peer's family is unavailable while A's
 * ledger holds a not_started release whose start error is the model-not-enabled class (lend-config-failure.ts) newer than
 * that peer + family's last explicit recovery. The evidence is the append-only release note itself (seq, time, order, text),
 * so nothing is copied and nothing expires with time.
 * - Placement: under on, configFailureV2 zeroes that family's slots on that peer before the planner sees them; other families
 *   and peers are untouched, live orders are never touched. observe / off return the facts unchanged (configFailureView
 *   shows the would-be pause). No notice is raised on A.
 * - Recovery only from the lender's own re-declaration, never a restart or elapsed time: after the fault the lender's hello
 *   withdraws the family (total 0 under a live grant), then a later hello (higher seq) offers it again. Under on only,
 *   inside recordHello's transaction; it records `through` = the newest event seq, CAS on its generation; a later failure has a higher seq and needs its own withdrawal, a replayed old hello is not a re-declaration.
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
/** withdrawn = the lender withdrew the family (total 0) while fault `fault` (its event seq) was active; boot + seq of that hello. */
interface Recovery { gen: number; through: number; boot: string; at: number; withdrawn?: { fault: number; boot: string; seq: number; at: number } | null }

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

const offers = (req: HelloRequest, f: LendFamily): boolean =>
  req.slots[f].total > 0 && !(req.paused && (req.paused.reason === `${f}_quota` || !req.paused.reason.endsWith("_quota")));

/**
 * Inside recordHello's transaction, after the hello was applied; only under on (observe / off write nothing). A restart is
 * not a recovery: the lender must first withdraw the family (slots total 0 under a live grant, its own declaration that it
 * is unavailable) after the fault, then offer it again. The lender's hello seq only grows, across its restarts too, so each
 * step must carry a seq above every hello seen before it: a delayed or replayed old hello never withdraws or re-declares.
 * The withdrawal is bound to the fault's event seq, so a newer fault needs a newer withdrawal; each step is a CAS.
 */
export function recoverOnRedeclare(db: Database, peer: string, prev: LendPeer | null, req: HelloRequest, now: number): void {
  if (configFailureMode() !== "on" || (prev && req.seq <= prev.seq)) return;
  const active = activeConfigFailures(db, peer);
  for (const family of LEND_FAMILIES) {
    const fault = active[family];
    if (!fault) continue;
    const { raw, r } = readRecovery(db, peer, family);
    const base: Recovery = r ?? { gen: 0, through: 0, boot: "", at: 0, withdrawn: null };
    if (req.grant && req.slots[family].total <= 0) { // no grant = 0 slots for every family: a revoke is not a withdrawal
      if (base.withdrawn?.fault !== fault.seq) recoverCas(db, peer, family, raw, { ...base, withdrawn: { fault: fault.seq, boot: req.boot, seq: req.seq, at: now } });
      continue;
    }
    const w = base.withdrawn;
    if (!w || w.fault !== fault.seq || req.seq <= w.seq || !offers(req, family)) continue;
    const top = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number | null }).s ?? 0;
    recoverCas(db, peer, family, raw, { gen: base.gen + 1, through: top, boot: req.boot, at: now, withdrawn: null });
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

/** The recovery generation on file (0 = never recovered). */
export const configRecoveryGen = (db: Database, peer: string, family: LendFamily): number => readRecovery(db, peer, family).r?.gen ?? 0;

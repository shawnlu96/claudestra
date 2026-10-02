import { SHARED_LEDGER_STALE_MS } from "./shared-ledger-contract.js";

export interface SharedLedgerCacheIdentity { centerId: string; teamId: string; personId: string; projectId: string }
export interface CacheTicket { key: string; generation: number; signal: AbortSignal }
interface Entry<T> { value: T; serverSeq: number; lastSuccessAt: number; rollback: boolean }
/** Identity changes invalidate in-flight tickets, including a switch away and back to the same member. */
export class SharedLedgerCache<T> {
  private generation = 0;
  private active = "";
  private controller = new AbortController();
  private entries = new Map<string, Entry<T>>();
  select(identity: SharedLedgerCacheIdentity): CacheTicket {
    const key = JSON.stringify([identity.centerId, identity.teamId, identity.personId, identity.projectId]);
    // Reselecting the same member can mean a different bridge/machine; old requests still lose their generation.
    this.controller.abort(); this.controller = new AbortController(); this.active = key; this.generation++;
    return { key, generation: this.generation, signal: this.controller.signal };
  }
  invalidate(ticket?: CacheTicket): void {
    if (ticket && (ticket.key !== this.active || ticket.generation !== this.generation)) return;
    this.controller.abort(); this.controller = new AbortController(); this.generation++; this.entries.delete(this.active);
  }
  store(ticket: CacheTicket, value: T, serverSeq: number, now = Date.now()): boolean {
    if (ticket.key !== this.active || ticket.generation !== this.generation) return false;
    if (!Number.isSafeInteger(serverSeq) || serverSeq < 0) throw new Error("invalid server sequence");
    // Whole snapshots replace even after a gap or backup rollback; never splice data across watermarks.
    const previous = this.entries.get(ticket.key);
    const rollback = !!previous && serverSeq < previous.serverSeq;
    this.entries.set(ticket.key, { value: structuredClone(value), serverSeq, lastSuccessAt: now, rollback });
    return true;
  }
  read(now = Date.now()): (Entry<T> & { stale: boolean }) | null {
    const entry = this.entries.get(this.active);
    return entry ? { ...structuredClone(entry), stale: now - entry.lastSuccessAt > SHARED_LEDGER_STALE_MS } : null;
  }
}

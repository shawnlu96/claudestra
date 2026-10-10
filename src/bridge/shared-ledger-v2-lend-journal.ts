import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../lib/file-lock.js";
import { bindingOf, type LendCentralBinding } from "../lib/ledger-lend-central-checks.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import { fail, v2ObjectDigest } from "../lib/shared-ledger-contract-v2.js";

/** Local recovery journal, separate from task projections. Only trusted bridge lookups may pin a binding. */
export interface LendCentralJournalEntry {
  localProjectId: string;
  localTaskId: string;
  binding: LendCentralBinding;
}

export class LendCentralJournal {
  constructor(private readonly directory: string) {}
  private path(orderId: string): string {
    return join(this.directory, "bindings", `${v2ObjectDigest(orderId)}.json`);
  }
  read(peer: string | null, orderId: string): LendCentralJournalEntry | null {
    const state = readJsonStateSync(this.path(orderId));
    if (state.status === "missing") return null;
    if (state.status !== "ok") throw new Error("lend central binding journal corrupt; recovery required");
    const row = state.data as LendCentralJournalEntry;
    if (!row || typeof row.localProjectId !== "string" || !row.localProjectId
      || typeof row.localTaskId !== "string" || !row.localTaskId) return fail("invalid_field");
    const binding = bindingOf(row.binding);
    if ((peer !== null && binding.peer !== peer) || binding.order.orderId !== orderId) return fail("forbidden");
    return { localProjectId: row.localProjectId, localTaskId: row.localTaskId, binding };
  }
  async pin(entry: LendCentralJournalEntry): Promise<LendCentralJournalEntry> {
    const binding = bindingOf(entry.binding), path = this.path(binding.order.orderId);
    mkdirSync(join(this.directory, "bindings"), { recursive: true, mode: 0o700 });
    const lock = await acquireLock(`${path}.lock`);
    if (!lock) return fail("resource_busy");
    try {
      const old = this.read(binding.peer, binding.order.orderId);
      // New fences never reinterpret an in-flight claim/result after a restart.
      if (old) {
        if (old.localProjectId !== entry.localProjectId || old.localTaskId !== entry.localTaskId
          || old.binding.fp !== binding.fp || v2ObjectDigest(old.binding.worker) !== v2ObjectDigest(binding.worker)
          || old.binding.executorInstanceId !== binding.executorInstanceId) return fail("forbidden");
        return old;
      }
      const row = { localProjectId: entry.localProjectId, localTaskId: entry.localTaskId, binding };
      if (!row.localProjectId || !row.localTaskId) return fail("invalid_field");
      writeJsonAtomicSync(path, row, { mode: 0o600, commitIf: lock.held });
      return row;
    } finally { lock.release(); }
  }
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { fail, parseCommand, parseReceipt, v2ObjectDigest, type V2Command, type V2Receipt } from "./shared-ledger-contract-v2.js";

export interface LendCentralPending { inputDigest: string; input: unknown; command: V2Command; receipt: V2Receipt | null }
/** Local recovery journal only. Its contents never authorize work or mark a task delivered. */
export class LendCentralOutbox {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private path(key: string) { return join(this.directory, `${v2ObjectDigest(key)}.json`); }
  read(key: string): LendCentralPending | null {
    const state = readJsonStateSync(this.path(key));
    if (state.status === "missing") return null;
    if (state.status !== "ok") throw new Error("lend central outbox corrupt; recovery required");
    const row = state.data as LendCentralPending;
    if (!row || !/^[a-f0-9]{64}$/.test(row.inputDigest) || v2ObjectDigest(row.input) !== row.inputDigest) return fail("invalid_field");
    const command = parseCommand(row.command);
    const receipt = row.receipt === null ? null : parseReceipt(row.receipt);
    return { inputDigest: row.inputDigest, input: row.input, command, receipt };
  }
  save(key: string, entry: LendCentralPending): void { writeJsonAtomicSync(this.path(key), entry, { mode: 0o600 }); }
  async exclusive<T>(key: string, run: (held: () => void) => Promise<T>): Promise<T> {
    const lock = await acquireLock(`${this.path(key)}.lock`);
    if (!lock) return fail("resource_busy");
    try {
      if (!lock.held()) return fail("resource_busy");
      return await run(() => { if (!lock.held()) fail("resource_busy"); });
    } finally { lock.release(); }
  }
}

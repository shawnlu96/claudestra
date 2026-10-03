import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import {
  array, choice, fail, id, nullable, object, parseOperationResult, refine, v2ObjectDigest, type Infer,
} from "./shared-ledger-contract-v2.js";
import { parseSchedulerCentralContext, type SchedulerCentralContext } from "./scheduler-central-context.js";

const parseStep = object({ operationId: id,
  state: choice(["started", "succeeded", "failed", "unknown"]) });
const parseJournalEntry = refine(object({
  context: parseSchedulerCentralContext, state: choice(["started", "confirmed", "unknown"]),
  result: nullable(parseOperationResult), steps: array(parseStep, 1000),
}), entry => entry.state !== "confirmed" || entry.result !== null);
export type SchedulerCentralJournalEntry = Infer<typeof parseJournalEntry>;

/** Local outbox, never an authorization source. A claim is permanent across process/boot/epoch changes: only explicit
 * reconciliation may settle an unknown action. A corrupt/half-written claim refuses execution instead of looking unused.
 * Call under the existing scheduler/maintenance lock; mkdir also arbitrates simultaneous claims for the same operation.
 */
export class SchedulerCentralJournal {
  constructor(private readonly root: string) {}
  private directory(c: SchedulerCentralContext): string {
    return join(this.root, v2ObjectDigest([c.teamId, c.projectId, c.taskId, c.intentId, c.operationId]));
  }
  read(c: SchedulerCentralContext): SchedulerCentralJournalEntry | null {
    const dir = this.directory(c), read = readJsonStateSync(join(dir, "outbox.json"));
    if (read.status !== "ok") {
      if (read.status === "missing") {
        // The claim may exist without its first record after a crash. It must never be considered a fresh operation.
        try { statSync(dir); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw e;
        }
      }
      fail("unknown_operation");
    }
    const entry = parseJournalEntry(read.data);
    if (v2ObjectDigest(entry.context) !== v2ObjectDigest(c)) fail("dedup_mismatch");
    return entry;
  }
  begin(c: SchedulerCentralContext): SchedulerCentralJournalEntry | null {
    parseSchedulerCentralContext(c);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { mkdirSync(this.directory(c), { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw e;
    }
    const entry: SchedulerCentralJournalEntry = { context: c, state: "started", result: null, steps: [] };
    this.write(entry);
    return entry;
  }
  write(entry: SchedulerCentralJournalEntry): void {
    const parsed = parseJournalEntry(entry);
    writeJsonAtomicSync(join(this.directory(parsed.context), "outbox.json"), parsed, { mode: 0o600 });
  }
}

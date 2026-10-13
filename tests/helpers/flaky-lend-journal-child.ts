/**
 * Lend-journal writes for a test that then starts the real manager CLI on the same journal file, done in a child process that has
 * exited before the call returns.
 *
 * Why not in the test process: bun:sqlite's close() is sqlite3_close_v2, and openLendJournal leaves statements unfinalized, so the
 * handle outlives close() (the -wal / -shm files stay; close(true) throws "database is locked"). The CLI's dry-run opens the journal
 * read-only with no busy_timeout, and under load it meets that lingering handle and answers "database is locked" (CI runs
 * 38328014574, 38228980725, 38320888315). A child's handles are gone for certain once it has exited.
 */
import "../runner-guard-entry.ts"; // run directly: pass the gate before the imports below (paths.ts creates the runtime dir on load)
import { advance, openLendJournal, recordAsked, type LendRow } from "../../src/lib/lend-journal.js";
import { workerName } from "../../src/lib/lend-worker-name.js";
import { guardRunner, runnerSpawnEnv } from "../runner-guard.ts";

export type JournalStep =
  /** asked → claimed → cloned → started → cancelled (settle recorded); answers the final row */
  | { op: "cancelled-order"; orderId: string; family: string; sessionId: string }
  /** a row from before settle existed: settle back to NULL; answers null */
  | { op: "clear-settle"; orderId: string };

function run(path: string, step: JournalStep): LendRow | null {
  const journal = openLendJournal(path);
  try {
    if (step.op === "clear-settle") {
      journal.query("UPDATE lend_orders SET settle = NULL WHERE orderId = ?").run(step.orderId);
      return null;
    }
    const { orderId, family, sessionId } = step;
    recordAsked(journal, { orderId, peer: "A", fp: "fp", family, preview: {} });
    advance(journal, orderId, "asked", "claimed", { leaseGen: 2, agent: workerName(orderId), dir: "/synthetic-clone" });
    advance(journal, orderId, "claimed", "cloned");
    advance(journal, orderId, "cloned", "started", { sessionId, startedAt: Date.now() - 1000 });
    return advance(journal, orderId, "started", "cancelled", { settle: { notify: null, removeDir: false } });
  } finally { journal.close(); }
}

/** Runs one step on the journal at `path` in a child with `env` (the caller's testChildEnv) and returns after the child has exited. */
export async function journalInChild(path: string, step: JournalStep, env: Record<string, string>): Promise<LendRow | null> {
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, path, JSON.stringify(step)], { env: { ...env, ...runnerSpawnEnv() }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`journal child (${step.op}) exited ${code}: ${err}`);
  return JSON.parse(out) as LendRow | null;
}

if (import.meta.main) {
  guardRunner(); // writes the journal: only when a test started it with the marker and a temporary HOME
  const [path, step] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(run(path!, JSON.parse(step!) as JournalStep)));
}

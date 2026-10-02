import { V2ContractError, type V2OperationResult } from "./shared-ledger-contract-v2.js";
import { assertLocalOwner, parseSchedulerCentralContext,
  type SchedulerCentralContext, type SchedulerCentralObservation, type SchedulerCentralRuntime } from "./scheduler-central-context.js";
import { checkSchedulerCentral, reportSchedulerCentral, schedulerCentralResult } from "./scheduler-central-gate.js";
import { SchedulerCentralJournal, type SchedulerCentralJournalEntry } from "./scheduler-central-journal.js";

export interface SchedulerCentralOutcome {
  state: "blocked" | "unknown" | "succeeded" | "failed";
  resourceHeld: boolean;
  reported: boolean;
  replayed: boolean;
  reason: string;
  result: V2OperationResult | null;
}
const reasonOf = (e: unknown) => e instanceof V2ContractError ? e.code : "unavailable";
const unknownObservation = (c: SchedulerCentralContext): SchedulerCentralObservation => ({
  state: "unknown", head: c.head, summary: "Execution outcome requires reconciliation", artifactIds: [],
});

function replay(entry: SchedulerCentralJournalEntry): SchedulerCentralOutcome {
  const confirmed = entry.state === "confirmed";
  return { state: confirmed ? entry.result!.state : "unknown", resourceHeld: !confirmed || entry.result!.state === "unknown",
    reported: confirmed, replayed: true, reason: confirmed ? "recorded_result" : "unknown_operation", result: entry.result };
}

/** No automatic resubmission, reconciliation, cancellation or remote process control. The caller may send a business
 * request to the home instance, but this adapter can only execute locally while both local and central ownership hold.
 */
export async function executeSchedulerCentral(input: SchedulerCentralContext, runtime: SchedulerCentralRuntime,
  journal: SchedulerCentralJournal, effect: (entry: SchedulerCentralJournalEntry) => Promise<SchedulerCentralObservation>,
  now: () => number = Date.now): Promise<SchedulerCentralOutcome> {
  const c = parseSchedulerCentralContext(input);
  const previous = journal.read(c);
  if (previous) return replay(previous);
  try { await checkSchedulerCentral(c, runtime); }
  catch (e) { return { state: "blocked", resourceHeld: true, reported: false, replayed: false, reason: reasonOf(e), result: null }; }
  const entry = journal.begin(c);
  if (!entry) return { state: "unknown", resourceHeld: true, reported: false, replayed: true, reason: "unknown_operation", result: null };
  let result: V2OperationResult;
  try {
    assertLocalOwner(c, runtime);
    result = schedulerCentralResult(c, await effect(entry), now());
    if (entry.steps.some(step => step.state === "started" || step.state === "unknown")) {
      result = schedulerCentralResult(c, unknownObservation(c), now());
    }
    // A lease/authorization lost during the effect makes even an apparent local success unconfirmed centrally.
    await checkSchedulerCentral(c, runtime);
  } catch {
    // A thrown/timed-out action may already have changed the world; keep resources and never call it again.
    result = schedulerCentralResult(c, unknownObservation(c), now());
  }
  entry.result = result;
  entry.state = "unknown";
  journal.write(entry); // the outbox is durable before any network result report
  try {
    await reportSchedulerCentral(c, runtime, result);
  } catch (e) {
    return { state: "unknown", resourceHeld: true, reported: false, replayed: false, reason: reasonOf(e), result };
  }
  entry.state = "confirmed";
  journal.write(entry);
  return { state: result.state, resourceHeld: result.state === "unknown", reported: true, replayed: false, reason: "recorded_result", result };
}

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, parseCommand, v2ObjectDigest, type V2Receipt } from "../src/lib/shared-ledger-contract-v2.js";
import { parseSchedulerCentralContext, type SchedulerCentralClient, type SchedulerCentralCommand } from "../src/lib/scheduler-central-context.js";
import { SchedulerCentralJournal } from "../src/lib/scheduler-central-journal.js";
import { configureSchedulerV2Intents, type SchedulerV2IntentCentral } from "../src/lib/scheduler-v2-intent.js";

const roots: string[] = [];
afterEach(() => { configureSchedulerV2Intents(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

export const INTENT_FENCE = { serviceGeneration: 1, epoch: 1, bootId: "boot-one" };

function receipt(c: SchedulerCentralCommand): V2Receipt {
  return { teamId: c.teamId, projectId: c.projectId, schemaVersion: 2, serviceGeneration: c.serviceGeneration,
    requestId: c.requestId, personId: "person", instanceId: "home", commandDigest: v2ObjectDigest(c), command: c.type,
    serverSeq: 1, committedAt: 2000, result: { entityId: "intent", rev: 1, specRev: 1, version: null, epoch: c.epoch,
      operationId: c.type === "intent.check" ? c.payload.operationId : c.type === "operation.result" ? c.payload.result.operationId : null } };
}

/**
 * Synthetic X8 center for S2I: fenced context from the trusted injection, a home-lock flag standing in for S2R, and a durable
 * journal in a temp dir. `client` defaults to a recording center; the flow tests pass the S2Q fixture's center (still recorded).
 */
export function intentCenter(client?: SchedulerCentralClient) {
  const root = mkdtempSync(join(tmpdir(), "s2i-journal-"));
  roots.push(root);
  const calls: SchedulerCentralCommand[] = [];
  const state = { held: true, refuse: null as string | null };
  const recording: SchedulerCentralClient = { async command(c) {
    parseCommand(c);
    calls.push(c);
    if (state.refuse && c.type !== "operation.result") fail(state.refuse as Parameters<typeof fail>[0]);
    return receipt(c);
  } };
  const journal = new SchedulerCentralJournal(root);
  const bound = (taskId: string, intentId: string, head: string | null, action: "dispatch" | "review"): SchedulerV2IntentCentral => {
    const bind = { taskId, featureId: "center-feature", taskRev: null, specRev: null, workflowRev: null, baseVersion: 0,
      proposalDigest: null, head, originalDigest: "a".repeat(64), sharedDigest: "b".repeat(64), actionDigest: "c".repeat(64),
      redactionVersion: 1, actions: ["workflow.auto" as const], homeInstanceId: "home", expiresAt: 9_999_999_999_999 };
    const context = parseSchedulerCentralContext({ teamId: "team", projectId: "center-project", ...INTENT_FENCE, homeInstanceId: "home",
      taskId, intentId, operationId: intentId, taskRev: 1, specRev: 1, workflowRev: 1, head, action,
      authorizationAskId: "ask-auto", authorizationBind: bind, authorizationDigest: v2ObjectDigest(bind) });
    const delegate: SchedulerCentralClient | null = client ? { command: async (c) => { calls.push(c); return client.command(c); } } : null;
    return { context, journal, runtime: { instanceId: "home", lock: { held: () => state.held }, client: delegate ?? recording } };
  };
  return { calls, state, journal, bound, types: () => calls.map((c) => c.type) };
}

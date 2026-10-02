import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import {
  array, fail, id, literal, nullable, object, parseCommand, text, timestamp, v2ObjectDigest,
  type V2Command,
} from "./shared-ledger-contract-v2.js";
import { verifyExecIdentity, type ExecIdentity } from "./shared-ledger-exec-gate.js";

type ResultCommand = Extract<V2Command, { type: "operation.result" | "lend.result" | "task.deliver" | "task.review" }>;
const resultTypes = new Set(["operation.result", "lend.result", "task.deliver", "task.review"]);
function resultCommand(input: unknown): ResultCommand {
  const command = parseCommand(input);
  if (!resultTypes.has(command.type)) fail("forbidden");
  return command as ResultCommand;
}
const entry = object({ command: resultCommand, savedAt: timestamp, state: literal("pending_submission") });
const draft = object({ id, content: text(16000), savedAt: timestamp });
const stateSchema = object({ schemaVersion: literal(1), identityKey: id,
  lastSuccessAt: nullable(timestamp), results: array(entry), drafts: array(draft) });
type State = ReturnType<typeof stateSchema>;

/** Local retention only. No transport, replay loop, authority bit, approval writer, or automatic deletion on restart.
 * X12 explicitly checks center receipt, current lease and versions before resubmitting a retained result.
 * The caller supplies a private local directory; this module never touches the default production state directory.
 */
export class SharedLedgerExecLocal {
  private readonly identity: ExecIdentity;
  private readonly identityKey: string;
  private readonly path: string;
  constructor(directory: string, identity: ExecIdentity, private readonly projectId: string, private readonly now: () => number = Date.now) {
    this.identity = verifyExecIdentity(identity, identity.teamId, id(projectId));
    this.identityKey = v2ObjectDigest({ centerId: identity.centerId, teamId: identity.teamId, projectId,
      personId: identity.actor.personId, instanceId: identity.actor.instanceId, serviceId: identity.actor.serviceId, orderId: identity.actor.orderId });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `exec-local-${this.identityKey}.json`);
  }
  private read(): State {
    const read = readJsonStateSync(this.path);
    if (read.status === "corrupt") fail("unavailable");
    if (read.status === "missing") return { schemaVersion: 1, identityKey: this.identityKey, lastSuccessAt: null, results: [], drafts: [] };
    const state = stateSchema(read.data);
    if (state.identityKey !== this.identityKey) fail("forbidden");
    for (const entry of state.results) this.validateResult(entry.command);
    return state;
  }
  private async update(mutate: (state: State) => void): Promise<void> {
    const lock = await acquireLock(`${this.path}.lock`);
    if (!lock) fail("unavailable");
    try {
      const state = this.read();
      mutate(state);
      writeJsonAtomicSync(this.path, stateSchema(state), { mode: 0o600, commitIf: lock.held });
    } finally { lock.release(); }
  }
  private validateResult(command: ResultCommand): void {
    if (command.teamId !== this.identity.teamId || command.projectId !== this.projectId) fail("forbidden");
    const actor = this.identity.actor;
    if (!actor.actions.includes(command.type)) fail("forbidden");
    const p = command.payload;
    const result = "result" in p ? p.result : p;
    if (actor.kind === "service" && "orderId" in result && result.orderId !== actor.orderId) fail("forbidden");
  }
  async saveResult(input: ResultCommand): Promise<{ state: "pending_submission"; authoritative: false }> {
    const command = resultCommand(input);
    this.validateResult(command);
    await this.update(state => {
      const previous = state.results.find(e => e.command.requestId === command.requestId);
      if (previous) {
        if (v2ObjectDigest(previous.command) !== v2ObjectDigest(command)) fail("dedup_mismatch");
        return;
      }
      state.results.push({ command, savedAt: this.now(), state: "pending_submission" });
    });
    return { state: "pending_submission", authoritative: false };
  }
  async saveDraft(draftId: string, content: string): Promise<void> {
    const value = draft({ id: draftId, content, savedAt: this.now() });
    await this.update(state => { state.drafts = [...state.drafts.filter(d => d.id !== value.id), value]; });
  }
  /** Informational timestamp supplied after a validated center response; never used by the gate or authorization checks. */
  async noteSuccess(at: number): Promise<void> {
    timestamp(at);
    await this.update(state => { state.lastSuccessAt = Math.max(state.lastSuccessAt ?? 0, at); });
  }
  view() {
    const state = this.read();
    return { results: state.results, drafts: state.drafts, lastSuccessAt: state.lastSuccessAt,
      displayOnly: true as const, authoritative: false as const };
  }
}

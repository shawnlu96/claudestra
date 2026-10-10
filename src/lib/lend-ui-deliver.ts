/**
 * LENDUI1: what a lent write order's delivery does with a screenshot manifest when uiDelivery itself is not on — its own
 * recovery key lendUiShots, so imported shots can be registered without turning the local delivery rule on. Called once by
 * writeLendDeliver inside its transaction; the answer is the ui port handed to deliver(). No manifest, uiDelivery on or
 * lendUiShots off = the port unchanged and nothing recorded. observe = check and note only. on = a valid manifest goes to
 * deliver() with mode on (existing code registers it); an invalid one is noted and the delivery enters as before — screenshots
 * never refuse a code delivery here. tests/lend-ui-deliver.test.ts.
 */
import type { Database } from "bun:sqlite";
import { planUiDelivery, type UiDeliverPort } from "./ledger-deliver-ui.js";
import type { LedgerTask } from "./ledger-stages.js";
import { lendUiDir, readLendUiProvenance } from "./lend-ui-provenance.js";
import { readUiEvidence, type UiEvidence } from "./order-deliver-ui.js";
import { recordObserved, recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";

export interface LendUiPort {
  /** recovery-policy lendUiShots, read at the write boundary */
  mode(project: string): RecoveryMode;
  /** one deduplicated note per card + target round + outcome + head */
  observe(db: Database, a: { project: string; target: string; actionKey: string; action: string; data: Record<string, unknown> }): void;
}

export function lendUiPort(o: { policyPath?: string; now?: number } = {}): LendUiPort {
  const path = o.policyPath ?? RECOVERY_POLICY_PATH;
  return {
    mode: (project) => recoveryPolicy(project, "lendUiShots", path).mode,
    observe: (db, a) => { recordObserved(db, { ...a, mechanism: "lendUiShots" }, o.now ?? Date.now()); },
  };
}

type Verdict = { ok: true; shots: number; digest: string } | { ok: false; code: string };

/** The uiDelivery check in observe terms (reads and hashes, never throws on a problem, writes nothing), then each ref's uploaded slot. */
function verify(db: Database, task: LedgerTask, input: { headSHA: string; uiEvidence: unknown }, port: UiDeliverPort): Verdict {
  const plan = planUiDelivery(db, task, input, { ...port, mode: () => ({ mode: "observe" }) });
  if (plan.observed) return { ok: false, code: plan.observed.code };
  let e: UiEvidence | null = null;
  try { e = readUiEvidence(input.uiEvidence); } catch { /* the plan above already answers invalid for it */ }
  const dir = port.peer ? lendUiDir(port.roots.imported, port.peer.peer, port.peer.orderId) : null;
  if (!e || !dir) return { ok: false, code: "invalid" };
  const prov = readLendUiProvenance(dir);
  if (prov.status !== "ok") return { ok: false, code: "provenance_invalid" };
  // the hash proves the bytes; this proves the peer lists each image for the view / size / phase it uploaded it as
  const moved = e.shots.some((s) => { const f = prov.data.files[s.ref]; return !f || f.view !== s.view || f.size !== s.size || f.phase !== s.phase; });
  return moved ? { ok: false, code: "slot_mismatch" } : { ok: true, shots: e.shots.length, digest: e.digest };
}

/** The ui port deliver() gets for this lend delivery. `port` is the uiDelivery one (peer set); the task is read inside the transaction. */
export function lendUiDeliverPort(db: Database, task: LedgerTask, input: { headSHA: string; uiEvidence?: unknown }, port: UiDeliverPort,
  lendUi: LendUiPort = lendUiPort()): UiDeliverPort {
  if (input.uiEvidence === undefined || port.mode(task.project).mode === "on") return port;
  const mode = lendUi.mode(task.project);
  if (mode === "off") return port;
  const v = verify(db, task, { headSHA: input.headSHA, uiEvidence: input.uiEvidence }, port);
  if (v.ok && mode === "on") return { ...port, mode: () => ({ mode: "on" }) };
  const round = task.stage === "review" ? task.round : task.round + 1;
  // a note that cannot be written never blocks the delivery (its savepoint rolls back alone), same as the uiDelivery note
  try {
    lendUi.observe(db, { project: task.project, target: task.id, actionKey: `lend-ui:r${round}:${v.ok ? "register" : v.code}:${input.headSHA.slice(0, 12)}`,
      action: v.ok ? `登记 ${v.shots} 张出借截图` : `不登记出借截图（不合格：${v.code}）`,
      data: v.ok ? { register: v.shots, digest: v.digest, head: input.headSHA } : { code: v.code, head: input.headSHA } });
  } catch (err) { console.error(`⚠️ ${task.id} 出借截图观察没记上：${(err as Error).message}`); }
  return port;
}

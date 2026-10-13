/**
 * RECBASE1 [验收线 4] · a formal recovery proof releases exactly the cancelled merge intent it is bound to, and only when sealed in
 * the writer's own transaction. The writer runs directly with an injected policy port (no policy file); the planner's guard
 * mergeRetryReleased is read on the resulting ledger events.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents, type LedgerError } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { ExplicitPolicyPort } from "../src/lib/manual-recovery-policy.js";
import { proveRecovery, registerManualRecovery } from "../src/lib/manual-recovery-release.js";
import { recoveryFence } from "../src/lib/scheduler-recovery-ports.js";
import { writeManualRecovery } from "../src/lib/scheduler-recovery-write.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { autoFixture, H1, H2 } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const onPort: ExplicitPolicyPort = () => () => ({ policy: { mode: "on", manualAfterMs: null, source: "config" }, explicit: "on" });
const bind = { cancel: "I1", releases: true };
let drop: (() => void) | null = null;
beforeEach(() => {
  Object.assign(bind, { cancel: "I1", releases: true });
  drop = registerManualRecovery({ id: "cancel-fixture", key: "manualRecovery", codes: ["merge_unknown"], get releasesCancel() { return bind.releases; },
    judge: ({ entrySeq }) => ({ ok: true, episodeId: `ep-${entrySeq}`, subreason: "merge_cancel", cancelIntentId: bind.cancel, evidenceSeq: entrySeq, next: "merge" }) });
});
afterEach(() => { drop?.(); drop = null; });

const intent = (f: F, id: string, status = "cancelled", head = H1) => f.db.query(`INSERT INTO scheduler_intents
  (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
  VALUES (?, 'T1', 'p', 'merge', 'merge', 1, 1, 1, 1, ?, 2, ?, 'x', 1, 1)`).run(id, head, status);
/** T1 on head H1 goes manual with merge_unknown; I1 is a cancelled merge on that head. */
async function cancelledManual(f: F, status = "cancelled") {
  f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(H1);
  intent(f, "I1", status);
  const wf = getWorkflow(f.db, "T1")!;
  expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "merge_unknown", "--reason", "合并意图 I1 已取消")).toMatchObject({ ok: true });
}
const write = (f: F) => {
  const v = proveRecovery(f.db, f.task(), getWorkflow(f.db, "T1"), "cancel-fixture", null);
  if (v.kind === "refused") return { ok: false, why: v.why };
  try {
    return writeManualRecovery(f.db, f.at("scheduler"), { ...recoveryFence(f.db, f.task()), mechanism: "cancel-fixture", mode: "on", maxWorkers: 2,
      fingerprint: v.proof.fingerprint, external: null }, () => {}, onPort);
  } catch (e) { return { ok: false, why: (e as LedgerError).message }; }
};
const events = (f: F) => listEvents(f.db, { project: "p", target: "T1" });
const released = (f: F, id = "I1", task = f.task()) => mergeRetryReleased(task, events(f), getIntent(f.db, id) as SchedulerIntent);
const run = async (f: F, body: (f: F) => Promise<void>) => { try { await body(f); } finally { f.close(); } };

describe("[验收线 4] a formal proof releases only the cancellation it is bound to", () => {
  test("the sealed proof releases I1; a later cancellation, head / spec / round drift or an unregistered mechanism do not", () => run(autoFixture(), async (f) => {
    await cancelledManual(f);
    expect(released(f)).toBe(false);
    expect(write(f)).toMatchObject({ ok: true, proof: { cancelIntentId: "I1", head: H1 } });
    expect(released(f)).toBe(true);
    intent(f, "I2");
    expect(released(f, "I2")).toBe(false);
    expect(released(f, "I1", { ...f.task(), headSHA: H2 })).toBe(false);
    expect(released(f, "I1", { ...f.task(), round: f.task().round + 1 })).toBe(false);
    expect(released(f, "I1", { ...f.task(), specRev: f.task().specRev + 1 })).toBe(false);
    bind.releases = false;
    expect(released(f)).toBe(false);
  }));

  test("a later PM mode change ends the release; a fresh hand-back needs its own proof", () => run(autoFixture(), async (f) => {
    await cancelledManual(f);
    expect(write(f)).toMatchObject({ ok: true });
    const wf = getWorkflow(f.db, "T1")!;
    expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
      "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "pm_takeover", "--reason", "PM 接管")).toMatchObject({ ok: true });
    expect(released(f)).toBe(false);
  }));

  test("forged authority: PM reason text, a note or an unsealed scheduler event carrying a proof never release", () => run(autoFixture(), async (f) => {
    await cancelledManual(f);
    const v = proveRecovery(f.db, f.task(), getWorkflow(f.db, "T1"), "cancel-fixture", null);
    if (v.kind !== "candidate") throw new Error(v.why);
    const wf = getWorkflow(f.db, "T1")!;
    const fake = `manual 扩展恢复（cancel-fixture）证明 ${v.proof.fingerprint}：merge_unknown/merge_cancel，绑定取消 I1，owner 已批准，CI 绿`;
    expect(await f.cli("pm", "note", "T1", fake)).toMatchObject({ ok: true });
    insertEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "note", text: fake, data: { op: "workflow_resume", auto: true, recoveryProof: v.proof } }, false);
    expect(released(f)).toBe(false);
    expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf.rev), "--reason", fake)).toMatchObject({ ok: true });
    expect(released(f)).toBe(false);
    const g = autoFixture();
    try {
      await cancelledManual(g);
      const p = proveRecovery(g.db, g.task(), getWorkflow(g.db, "T1"), "cancel-fixture", null);
      if (p.kind !== "candidate") throw new Error(p.why);
      // a scheduler-actor workflow_resume with the proof but no seal from the writer's transaction
      insertEvent(g.db, g.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "伪造",
        data: { op: "workflow_resume", from: "manual", auto: true, workflowRev: p.proof.workflowRev + 1, recoveryProof: p.proof } }, false);
      expect(released(g)).toBe(false);
    } finally { g.close(); }
  }));

  test("a proof may bind only a cancelled merge of this card, and only from a mechanism allowed to", () => run(autoFixture(), async (f) => {
    await cancelledManual(f, "done");
    expect(write(f)).toMatchObject({ ok: false, why: expect.stringContaining("不是本卡本规格已取消的合并") });
    f.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'I1'").run();
    bind.releases = false;
    expect(write(f)).toMatchObject({ ok: false, why: expect.stringContaining("不能绑定取消意图") });
    bind.releases = true; bind.cancel = "I9";
    expect(write(f)).toMatchObject({ ok: false, why: expect.stringContaining("I9") });
    expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
  }));
});

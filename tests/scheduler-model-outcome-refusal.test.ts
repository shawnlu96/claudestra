/**
 * dispatch-recovery-MODEL · owner approval ask_muumcchk8d0596d05d: a reviewer's refusal of an allowed routine read-only
 * review retries once on the same model in a new session, a second refusal goes once to another family under the
 * recorded exemption, and everything else stays a manual hold. The approval comes from an injected port only.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { EXEMPTION_TEXT, planModelRecovery, recordModelOutcome, type OutcomeInput, type RecoveryFacts, type RefusalApproval,
  type RefusalApprovalPort, type RecoveryPolicyPort } from "../src/lib/scheduler-model-outcome.js";
import { openRefusal, openSafetyHold } from "../src/lib/scheduler-review-swap.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const REFUSAL = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const CYBER = "This request has been flagged for possible cybersecurity risk";
const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null });
const observe: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null });
const off: RecoveryPolicyPort = () => ({ mode: "off", manualAfterMs: null });
const APPROVED: RefusalApproval = { approvalId: "ask_muumcchk8d0596d05d", source: "owner self · button policy_refusal_rule_go",
  scope: "routine_readonly_review", content: "allowed", revoked: false, ownerHold: false };
const approve = (over: Partial<RefusalApproval> = {}): RefusalApprovalPort => () => ({ ...APPROVED, ...over });
const DIGEST = "sha256:materials-1";

describe("approved refusal continuation (pure)", () => {
  const base: RecoveryFacts = { role: "reviewer", authorFamily: "claude", failed: { family: "codex", machine: "local" },
    authorized: [{ family: "codex", machine: "local" }, { family: "claude", machine: "backup" }], noResult: true, ended: true,
    refusal: { approval: APPROVED, prior: [], materialDigest: DIGEST, sessionId: "s1", newTicket: true } };
  const retried = { step: "retry_same" as const, family: "codex" as const, digest: DIGEST, session: "s1", seq: 5 };
  const second = (over: Partial<NonNullable<RecoveryFacts["refusal"]>> = {}): RecoveryFacts =>
    ({ ...base, refusal: { ...base.refusal!, prior: [retried], sessionId: "s2", ...over } });

  test("first eligible refusal: same model, same placement, new session, one retry", () => {
    expect(planModelRecovery("safety", false, base)).toMatchObject({ kind: "retry_same", to: { family: "codex", machine: "local" },
      attempt: 1, newSession: true, approvalId: APPROVED.approvalId });
  });

  test("second refusal of that model on the same materials in a new session: one exemption to another family", () => {
    const p = planModelRecovery("safety", false, second());
    expect(p).toMatchObject({ kind: "exempt_review", to: { family: "claude", machine: "backup" }, attempt: 2, exemption: EXEMPTION_TEXT,
      notifyOwner: true, approvalId: APPROVED.approvalId, crossModel: false });
    // Same family as the author: honestly not cross-model.
    expect(p.kind === "exempt_review" && p.reason).toContain("不算跨模型");
  });

  test("everything outside the approved bounds stays a manual hold", () => {
    const hold = { kind: "manual", code: "model_safety_hold" };
    const cases: RecoveryFacts[] = [
      { ...base, refusal: undefined },
      { ...base, role: "author" },
      { ...base, refusal: { ...base.refusal!, approval: null } },
      { ...base, refusal: { ...base.refusal!, approvalDiag: "port threw" } },
      { ...base, refusal: { ...base.refusal!, approval: { ...APPROVED, revoked: true } } },
      { ...base, refusal: { ...base.refusal!, approval: { ...APPROVED, ownerHold: true } } },
      { ...base, refusal: { ...base.refusal!, approval: { ...APPROVED, content: "uncertain" } } },
      { ...base, refusal: { ...base.refusal!, approval: { ...APPROVED, content: "disallowed" } } },
      { ...base, refusal: { ...base.refusal!, materialDigest: null } },
      { ...base, noResult: false },
      { ...base, ended: false },
      { ...base, authorized: [{ family: "claude", machine: "backup" }] }, // the refused placement is not authorized
      second({ materialDigest: "sha256:changed" }),
      second({ sessionId: "s1" }),
      second({ newTicket: false }),
      second({ prior: [{ ...retried, family: "claude" }] }),
      { ...second(), authorized: [{ family: "codex", machine: "local" }, { family: "codex", machine: "other" }] }, // no other family
      second({ prior: [retried, { ...retried, step: "exempt_review", family: "claude", seq: 9 }] }), // after the exemption
      second({ prior: [{ ...retried, step: "manual" }] }),
      second({ approval: { ...APPROVED, revoked: true } }),
    ];
    for (const f of cases) expect(planModelRecovery("safety", false, f)).toMatchObject(hold);
  });
});

/** Real ledger: the card reaches review, Codex reviewer agent-rv-t1 gets a formal review ticket from the real tick. */
async function reviewing() {
  const f = autoFixture();
  const { toBuild } = await import("./scheduler-auto-helpers.js");
  await toBuild(f);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "session" });
  expect(await f.tick()).toMatchObject({ step: "sent" });
  const first = f.intents().findLast((i) => i.action === "review")!;
  /** A formal new review ticket for the same window, planned through the real intent writer; the refused one ended first. */
  const ticket = (id: string) => {
    for (const i of f.intents().filter((x) => x.status === "pending")) settleIntent(f.db, f.at("scheduler"), { id: i.id, from: "pending", to: "cancelled", receipt: "拒审，原单终止" });
    const task = getTask(f.db, "T1")!, seq = (f.db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
    return planIntent(f.db, f.at("scheduler"), { id, taskId: "T1", taskRev: task.rev, workflowRev: getWorkflow(f.db, "T1")!.rev, causalSeq: seq,
      action: "review", node: "adversarial_review", reason: "批准的接续审查", resources: [] }).intent;
  };
  const input = (intentId: string, sessionId: string, more: Partial<OutcomeInput> = {}): OutcomeInput => ({ intentId,
    signal: { failure: { kind: "error", message: REFUSAL } }, failed: { agent: "agent-rv-t1", family: "codex", machine: "local" },
    authorized: [{ family: "codex", machine: "local" }, { family: "claude", machine: "backup" }], ended: true,
    review: { sessionId, materialDigest: DIGEST }, ...more });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const outcomes = () => events().filter((e) => String(e.data.op).startsWith("model_"));
  return { f, first, ticket, input, events, outcomes };
}

describe("approved refusal continuation (real ledger)", () => {
  test("on: retry → exemption → hold, each once, with evidence, sessions, digest, approval and attempt on the record", async () => {
    const { f, first, ticket, input, events, outcomes } = await reviewing();
    try {
      const rec = (i: OutcomeInput, port: RefusalApprovalPort = approve()) => recordModelOutcome(f.db, f.at("scheduler"), i, on, port);
      const r1 = rec(input(first.id, "s-rv"));
      expect(r1).toMatchObject({ kind: "recorded", cls: "safety", duplicate: false, plan: { kind: "retry_same", to: { family: "codex", machine: "local" } },
        event: { kind: "note", data: { op: "model_refusal_retry", role: "reviewer", attempt: 1, session: "s-rv", oldSession: null, materialDigest: DIGEST,
          approvalId: APPROVED.approvalId, approvalSource: APPROVED.source, evidence: REFUSAL, noReport: true, verdict: null } } });
      if (r1.kind !== "recorded") throw new Error("unreachable");
      expect(r1.materials).toContain("不是 pass");
      // Restart / concurrent replay of the same ticket: same record, no second attempt counted.
      expect(rec(input(first.id, "s-rv"), approve({ revoked: true }))).toMatchObject({ duplicate: true, event: { seq: r1.event.seq } });
      expect(rec(input(first.id, "s-rv", { signal: { failure: { kind: "error", message: CYBER } } }))).toMatchObject({ duplicate: true });
      // No hold, but the automatic family switch stays blocked while the approved retry is outstanding.
      expect(openSafetyHold(events())).toBeNull();
      expect(openRefusal(events())?.seq).toBe(r1.event.seq);

      const second = ticket("refusal-retry-1");
      const r2 = rec(input(second.id, "s-rv-2"));
      expect(r2).toMatchObject({ duplicate: false, plan: { kind: "exempt_review", to: { family: "claude", machine: "backup" }, exemption: EXEMPTION_TEXT,
        crossModel: false, notifyOwner: true }, event: { kind: "escalate", data: { op: "model_refusal_exempt", attempt: 2, session: "s-rv-2", oldSession: "s-rv" } } });
      if (r2.kind !== "recorded") throw new Error("unreachable");
      expect(r2.materials).toContain(EXEMPTION_TEXT);
      expect(r2.materials).toContain(APPROVED.approvalId);
      expect(r2.materials).toContain("不是 pass");

      // Refused again after the exemption: manual hold, never another provider.
      const third = ticket("refusal-exempt-1");
      const r3 = rec(input(third.id, "s-claude", { failed: { agent: "agent-claude-bk", family: "claude", machine: "backup" } }));
      expect(r3).toMatchObject({ plan: { kind: "manual", code: "model_safety_hold", reason: expect.stringContaining("不再换提供方") },
        event: { kind: "escalate", data: { op: "model_safety_hold", attempt: 3 } } });
      if (r3.kind !== "recorded") throw new Error("unreachable");
      expect(openSafetyHold(events())?.seq).toBe(r3.event.seq);
      expect(outcomes().map((e) => e.data.op)).toEqual(["model_refusal_retry", "model_refusal_exempt", "model_safety_hold"]);
    } finally { f.close(); }
  });

  test("on: revoked / owner hold / uncertain content / missing or broken port / changed materials → hold, not a continuation", async () => {
    const ports: (RefusalApprovalPort | undefined)[] = [approve({ revoked: true }), approve({ ownerHold: true }), approve({ content: "uncertain" }),
      undefined, () => { throw new Error("store unreadable"); }, () => null];
    for (const port of ports) {
      const { f, first, input } = await reviewing();
      try {
        expect(recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, port))
          .toMatchObject({ plan: { kind: "manual", code: "model_safety_hold" }, event: { data: { op: "model_safety_hold", attempt: 1 } } });
      } finally { f.close(); }
    }
    const { f, first, ticket, input } = await reviewing();
    try {
      recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, approve());
      const t = ticket("refusal-retry-1");
      expect(recordModelOutcome(f.db, f.at("scheduler"), { ...input(t.id, "s-rv-2"), review: { sessionId: "s-rv-2", materialDigest: "sha256:edited" } }, on, approve()))
        .toMatchObject({ plan: { kind: "manual", reason: expect.stringContaining("摘要不一致") } });
    } finally { f.close(); }
  });

  test("a new head opens a new window: the attempt count restarts there", async () => {
    const { f, first, ticket, input } = await reviewing();
    try {
      recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, approve());
      f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["c".repeat(40)]);
      const t = ticket("refusal-new-head");
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(t.id, "s-rv-2"), on, approve()))
        .toMatchObject({ plan: { kind: "retry_same" }, event: { data: { attempt: 1, window: `${f.task().specRev}:${"c".repeat(40)}` } } });
    } finally { f.close(); }
  });

  test("late refusal of an old head must not open a retry window on the current head", async () => {
    const { f, first, ticket, input, events } = await reviewing();
    try {
      const H2 = "c".repeat(40), rec = (i: OutcomeInput) => recordModelOutcome(f.db, f.at("scheduler"), i, on, approve());
      f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [H2]);
      // The H1 ticket's refusal arrives after the head moved: evidence stays in H1's window, nothing is continued.
      const late = rec(input(first.id, "s-rv"));
      expect(late).toMatchObject({ plan: { kind: "manual", code: "model_recovery_manual", reason: expect.stringContaining("过期") },
        event: { kind: "note", data: { op: "model_refusal_stale", head: H1, window: `${f.task().specRev}:${H1}`, evidence: REFUSAL, session: "s-rv", noReport: true } } });
      expect(openRefusal(events())).toBeNull();
      const t = ticket("refusal-h2");
      expect(recordModelOutcome(f.db, f.at("scheduler"), { ...input(t.id, "s-new-head"), review: { sessionId: "s-new-head", materialDigest: "sha256:actual-new-materials" } }, on, approve()))
        .toMatchObject({ plan: { kind: "retry_same" }, event: { data: { op: "model_refusal_retry", attempt: 1, head: H2,
          window: `${f.task().specRev}:${H2}`, materialDigest: "sha256:actual-new-materials" } } });
    } finally { f.close(); }
  });

  test("late refusal of an old spec revision is stale too", async () => {
    const { f, first, input, events } = await reviewing();
    try {
      const spec = f.task().specRev;
      f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'");
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, approve()))
        .toMatchObject({ plan: { kind: "manual", code: "model_recovery_manual" },
          event: { kind: "note", data: { op: "model_refusal_stale", specRev: spec, currentSpecRev: spec + 1, window: `${spec}:${H1}` } } });
      expect(openRefusal(events())).toBeNull();
    } finally { f.close(); }
  });

  test("malformed approval with missing safety flags must fail closed", async () => {
    const shapes = [{ approvalId: APPROVED.approvalId, source: APPROVED.source, scope: "routine_readonly_review", content: "allowed" },
      { ...APPROVED, revoked: "false" }, { ...APPROVED, ownerHold: 0 }, { ...APPROVED, approvalId: 42 }, { ...APPROVED, content: "maybe" }];
    for (const shape of shapes) {
      const { f, first, input } = await reviewing();
      try {
        expect(recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, () => shape as unknown as RefusalApproval))
          .toMatchObject({ plan: { kind: "manual", code: "model_safety_hold" } });
      } finally { f.close(); }
    }
  });

  test("observe only reports the step on would take; off records nothing", async () => {
    const { f, first, ticket, input, events, outcomes } = await reviewing();
    try {
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), off, approve())).toEqual({ kind: "off" });
      expect(outcomes()).toHaveLength(0);
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), observe, approve()))
        .toMatchObject({ mode: "observe", plan: { kind: "retry_same" }, event: { kind: "note", data: { op: "model_outcome" } } });
      const t = ticket("refusal-retry-1");
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(t.id, "s-rv-2"), observe, approve()))
        .toMatchObject({ plan: { kind: "exempt_review" }, event: { kind: "note", data: { op: "model_outcome", attempt: 2 } } });
      expect(openRefusal(events())).toBeNull();
    } finally { f.close(); }
  });

  test("two connections recording the same ticket at once write one record (immediate transaction + dedup key)", async () => {
    const { f, first, input, outcomes } = await reviewing();
    const path = (f.db.query("PRAGMA database_list").get() as { file: string }).file;
    const other = new Database(path);
    try {
      other.run("PRAGMA busy_timeout = 2000");
      const a = recordModelOutcome(other, f.at("scheduler"), input(first.id, "s-rv"), on, approve());
      const b = recordModelOutcome(f.db, f.at("scheduler"), input(first.id, "s-rv"), on, approve());
      expect([a, b].map((r) => r.kind === "recorded" && r.duplicate)).toEqual([false, true]);
      expect(outcomes()).toHaveLength(1);
    } finally { other.close(); f.close(); }
  });
});

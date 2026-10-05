/**
 * dispatch-recovery-FB2P on a real temp ledger: the R1 incident (a fix for write-lease holder "mate" refused by the outbound gate,
 * tests/scheduler-dispatch-block-helpers.ts) fed through the existing fact readers into the local-takeover planner. Only a proven
 * case is eligible; every wrong reading of "it did not go out" blocks; the same facts give the same plan across a reopen, and any
 * evidence change voids an old plan. The planner writes nothing.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { getMeta, getTask } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { assessLocalFallback, planLocalFallback, readLocalFallbackFacts, staleBasis, type EligiblePlan, type LocalFallbackFacts,
  type LocalFallbackPolicyPort } from "../src/lib/recovery-local-fallback-plan.js";
import { specPathFor } from "../src/lib/task-spec.js";
import { recordModelOutcome } from "../src/lib/scheduler-model-outcome.js";
import { blockFixture, E2E_MS, toFix, type Fx } from "./scheduler-dispatch-block-helpers.js";

// A 64-hex on a line naming a secret: GATE4 never cuts it, so the gate still refuses it (a bare 64-hex digest is now cut and goes out).
const leaked = () => `# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 secret ${randomBytes(32).toString("hex")}`;
const on: LocalFallbackPolicyPort = () => ({ mode: "on", manualAfterMs: null });
const OK = { ok: true } as const;
const BORROW = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];

/** The R1 refusal with this machine's Codex seated (agents.codex = 1): mate stays the lease holder, the fix never left. */
async function refused(): Promise<Fx> {
  const p = await blockFixture();
  await toFix(p, leaked());
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  p.policy.remote.agents = { claude: 1, codex: 1 };
  return p;
}

const facts = (p: Fx, over: Partial<LocalFallbackFacts> = {}, db = p.f.db): LocalFallbackFacts => ({
  ...readLocalFallbackFacts(db, getTask(db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: p.policy.remote, borrow: BORROW } },
    { slot: OK, quota: OK }), ...over });

const counts = (p: Fx) => ({ events: p.events().length, intents: p.f.intents().map((i) => `${i.id}:${i.status}`), orders: p.orders().map((o) => o.status),
  task: getTask(p.f.db, "T1")!.rev });

describe("FB2P eligible: only the proven gate-refused fix", () => {
  test("plan keeps task / spec / branch / head / lease / author and the review requirement; planning writes nothing", async () => {
    const p = await refused();
    try {
      const before = counts(p);
      const plan = planLocalFallback(facts(p, { unpushed: [{ kind: "worktree", ref: "wt/t1", note: "2 commits not pushed" }] }), on) as EligiblePlan;
      expect(plan).toMatchObject({ kind: "eligible", role: "fix", trigger: { kind: "gate_refused", reason: expect.stringContaining("外发闸") },
        exec: { machine: "local", family: "codex", authorFamily: "codex", workflowMode: "auto" },
        review: { family: "claude", independent: true, crossModelFrom: "codex" },
        preserve: { taskId: "T1", round: 1, specRev: 1, branch: "lend/T1-abcd", leaseBranch: "lend/T1-abcd", head: "2".repeat(40),
          unpushed: [{ kind: "worktree", ref: "wt/t1", note: "2 commits not pushed" }] } });
      expect(plan.steps.map((s) => s.op)).toEqual(["revalidate", "end_write_lease", "bind_local_author", "dispatch_work", "independent_review"]);
      expect(plan.steps[1]!.params).toMatchObject({ peer: "mate", branch: "lend/T1-abcd", formal: "reclaimLend" });
      expect(plan.steps[3]!.params).toMatchObject({ role: "fix", head: "2".repeat(40), branch: "lend/T1-abcd" });
      expect(JSON.stringify(plan).includes("\"done\"")).toBe(false); // no fake verdict / done anywhere in the plan
      expect(counts(p)).toEqual(before);
      expect(p.f.task()).toMatchObject({ stage: "fix", agent: null });
      expect(p.fixes()).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("same snapshot → same plan, also from a freshly opened ledger (restart); changed evidence voids the old plan", async () => {
    const p = await refused();
    try {
      const first = planLocalFallback(facts(p), on) as EligiblePlan;
      expect(planLocalFallback(facts(p), on)).toEqual(first);
      const reopened = new Database(join(p.f.dir, "ledger.sqlite"), { readonly: true });
      try { expect(planLocalFallback(facts(p, {}, reopened), on)).toEqual(first); } finally { reopened.close(); }
      expect(staleBasis(first.basis, facts(p), on)).toEqual([]);
      // A plain PM note is a new event: the old plan is void even though the decision would not change.
      insertEvent(p.f.db, p.f.at("pm"), { project: "p", target: "T1", kind: "note", text: "看了一下", data: {} }, true);
      expect(staleBasis(first.basis, facts(p), on)).toEqual(["lastSeq"]);
      const second = planLocalFallback(facts(p), on) as EligiblePlan;
      expect(second.kind).toBe("eligible");
      expect(second.key).not.toBe(first.key);
      // Head / branch moved under the plan.
      p.f.db.run("UPDATE tasks SET headSHA = ?, branch = ? WHERE id = 'T1'", ["3".repeat(40), "lend/T1-other"]);
      expect(staleBasis(second.basis, facts(p), on)).toEqual(expect.arrayContaining(["head", "branch"]));
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a new author session or a new review (material) voids it too; the re-review makes the block retry, not a takeover", async () => {
    const p = await refused();
    try {
      const first = planLocalFallback(facts(p), on) as EligiblePlan;
      p.f.db.run("UPDATE scheduler_sessions SET sessionId = 's-two' WHERE taskId = 'T1' AND role = 'author'");
      expect(staleBasis(first.basis, facts(p), on)).toEqual(["author"]);
      p.rereview("# 审查报告\nP1：两个 tick 抢同一个意图（复现见 tests/x.test.ts）");
      expect(staleBasis(first.basis, facts(p), on)).toEqual(expect.arrayContaining(["lastSeq", "trigger", "author"]));
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "not_candidate" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("revoked grant, an edited spec, a lost proof or the policy turned off void an old plan; a matching basis alone is never enough", async () => {
    const p = await refused();
    try {
      const first = planLocalFallback(facts(p), on) as EligiblePlan;
      expect(first.kind).toBe("eligible");
      p.policy.remote.agents = { claude: 1, codex: 0 };
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "no_grant" });
      expect(staleBasis(first.basis, facts(p), on)).toEqual(["grant", "eligibility"]);
      p.policy.remote.agents = { claude: 1, codex: 1 };
      expect(staleBasis(first.basis, facts(p), on)).toEqual([]);
      // The spec file itself edited to manual acceptance, read back through the real fact reader.
      const task = getTask(p.f.db, "T1")!, path = specPathFor(task, getMeta(p.f.db, "p").docsDir)!;
      const original = facts(p).specText!;
      writeFileSync(path, `人工验收：是\n\n${original}`);
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "owner_hold" });
      expect(staleBasis(first.basis, facts(p), on)).toEqual(["spec", "eligibility"]);
      writeFileSync(path, original);
      expect(staleBasis(first.basis, facts(p), on)).toEqual([]);
      expect(staleBasis(first.basis, facts(p, { quota: { ok: false, why: "Codex 周额度 7d 用量未知" } }), on)).toEqual(["proofs", "eligibility"]);
      expect(staleBasis(first.basis, facts(p), () => ({ mode: "off", manualAfterMs: null }))).toEqual(["policy"]);
      expect(staleBasis(first.basis, facts(p), undefined)).toEqual(["policy"]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2P blocked: undelivered is proven, never assumed", () => {
  test("the gate-refused fix whose file another card has since locked: lock_busy, and the old plan is void", async () => {
    const p = await refused();
    try {
      const first = planLocalFallback(facts(p), on) as EligiblePlan;
      expect(first.kind).toBe("eligible");
      const t1 = p.f.db.query("SELECT * FROM tasks WHERE id = 'T1'").get() as Record<string, unknown>;
      const row = { ...t1, id: "T2" };
      p.f.db.run(`INSERT INTO tasks (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row) as never[]);
      const first1 = p.f.db.query("SELECT * FROM scheduler_intents WHERE taskId = 'T1' ORDER BY eventSeq").get() as Record<string, unknown>;
      const intent = { ...first1, id: "t2:s1:r0:build:a0", taskId: "T2", status: "submitted" };
      p.f.db.run(`INSERT INTO scheduler_intents (${Object.keys(intent).join(",")}) VALUES (${Object.keys(intent).map(() => "?").join(",")})`, Object.values(intent) as never[]);
      p.f.db.run("DELETE FROM scheduler_resources WHERE taskId = 'T1' AND resource = 'src/lib/x.ts'");
      p.f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/lib/x.ts', 'T2', ?, 1, 'intent')", [intent.id]);
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "lock_busy", reasons: [expect.stringContaining("src/lib/x.ts@T2")] });
      expect(staleBasis(first.basis, facts(p), on)).toEqual(["locks", "eligibility"]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("submitted without a sent receipt, unknown or pending intents block; a cancelled one is the proof", async () => {
    const p = await refused();
    try {
      const fix = p.f.intents().find((i) => i.node === "fix")!;
      expect(fix.status).toBe("cancelled");
      for (const status of ["submitted", "unknown", "pending"]) {
        p.f.db.run("UPDATE scheduler_intents SET status = ? WHERE id = ?", [status, fix.id]);
        const plan = assessLocalFallback(facts(p));
        // A live intent is also the planner's own in-flight wait, so either gate stops it; neither may say eligible.
        expect(plan.kind).toBe("blocked");
        expect(["delivery_unproven", "not_candidate"]).toContain((plan as { code: string }).code);
      }
    } finally { p.f.close(); }
  }, E2E_MS);

  test("an earlier fix order of this round that is unknown, claimed or pooled blocks; cancelled / released is the formal end", async () => {
    const p = await refused();
    try {
      // A copy of mate's real build order as an earlier fix offer of this round (the build order itself stays done: it says who wrote H2).
      const old = "lend:T1:s1:r1:old";
      const row = { ...p.f.db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(p.orders()[0]!.orderId) as Record<string, string | number | null>,
        orderId: old, step: "fix", round: 1, status: "cancelled" };
      p.f.db.run(`INSERT INTO lend_orders (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
      for (const status of ["unknown", "claimed", "pooled"]) {
        p.f.db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [status, old]);
        expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "delivery_unproven", reasons: [expect.stringContaining(old)] });
      }
      for (const status of ["cancelled", "released"]) {
        p.f.db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [status, old]);
        expect(assessLocalFallback(facts(p)).kind).toBe("eligible");
      }
      // A done order of this very fix round is a result, not a refusal.
      p.f.db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [old]);
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "result_exists" });
      // Without mate's done build order the head's writer is the workflow's Claude: a local Codex would switch the model.
      p.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId != ?", [old]);
      p.f.db.run("DELETE FROM lend_orders WHERE orderId = ?", [old]);
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "family_switch" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a provider safety refusal (formal model-outcome hold) and a frozen queue are not takeovers", async () => {
    const p = await refused();
    try {
      const fix = p.f.intents().find((i) => i.node === "fix")!;
      const rec = recordModelOutcome(p.f.db, p.f.at("scheduler"), { intentId: fix.id, ended: true, authorized: [],
        signal: { failure: { kind: "error", message: "This request has been flagged for possible cybersecurity risk" } },
        failed: { family: "codex", machine: "mate", agent: "w1" } }, () => ({ mode: "on", manualAfterMs: null }));
      expect(rec).toMatchObject({ kind: "recorded", cls: "safety" });
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "safety_hold" });
    } finally { p.f.close(); }
    const q = await refused();
    try {
      expect(await q.cli("owner", "freeze", "--reason", "owner 冻结", "--project", "p")).toMatchObject({ ok: true });
      expect(assessLocalFallback(facts(q))).toMatchObject({ kind: "blocked", code: "owner_hold", reasons: ["项目队列冻结"] });
    } finally { q.f.close(); }
  }, E2E_MS);

  test("no Codex seat, no slot or quota proof, an unreadable spec or a private ban: blocked, never 'add a seat'", async () => {
    const p = await refused();
    try {
      p.policy.remote.agents = { claude: 1, codex: 0 };
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "no_grant" });
      p.policy.remote.agents = { claude: 1, codex: 1 };
      p.policy.remote.localPriority = "off";
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "no_grant", reasons: [expect.stringContaining("localPriority=off")] });
      delete p.policy.remote.localPriority;
      expect(assessLocalFallback(facts(p, { slot: { ok: false, why: "Codex 全机会话已达 6" } })))
        .toMatchObject({ code: "no_slot", reasons: ["Codex 全机会话已达 6"] });
      expect(assessLocalFallback(facts(p, { quota: { ok: false, why: "Codex 额度未知" } }))).toMatchObject({ code: "no_quota" });
      expect(assessLocalFallback(facts(p, { specText: null }))).toMatchObject({ code: "spec_unreadable" });
      expect(assessLocalFallback(facts(p, { outboundBan: "私仓禁止外派" }))).toMatchObject({ code: "private_ban", reasons: ["私仓禁止外派"] });
      expect(assessLocalFallback(facts(p, { specText: "本机限定：是\n\n规格" }))).toMatchObject({ code: "private_ban" });
      expect(assessLocalFallback(facts(p, { specText: "人工验收：是\n\n规格" }))).toMatchObject({ code: "owner_hold" });
      const blockedText = JSON.stringify(assessLocalFallback(facts(p, { slot: { ok: false, why: "满" } })));
      expect(/加位|换模型|扩容/.test(blockedText)).toBe(false);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("legacy pool (no agents): localPriority off or maxActiveWorkers 0 is no grant even with Codex as the local runtime", async () => {
    const p = await refused();
    try {
      delete p.policy.remote.agents;
      Object.assign(p.policy.remote, { localAuthorRuntime: "codex", localFamilies: ["codex"] });
      expect(assessLocalFallback(facts(p)).kind).toBe("eligible");
      p.policy.remote.localPriority = "off";
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "no_grant", reasons: [expect.stringContaining("localPriority=off")] });
      p.policy.remote.localPriority = "low";
      expect(assessLocalFallback(facts(p)).kind).toBe("eligible");
      const noWorker = readLocalFallbackFacts(p.f.db, getTask(p.f.db, "T1")!, { registry: [], maxWorkers: 0, now: p.f.tickDeps.now(),
        pool: { remote: p.policy.remote, borrow: BORROW } }, { slot: OK, quota: OK });
      expect(assessLocalFallback(noWorker)).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("maxActiveWorkers=0")] });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a non-auto card is never turned into one", async () => {
    const p = await refused();
    try {
      p.f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "not_auto" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

/**
 * dispatch-recovery-FB2P, second half: the policy port (on / observe / off, missing, throwing, garbage), the Codex quota proof
 * built on the existing quota reader, and the "no peer it may safely go to" trigger on a real temp ledger — a build pinned to
 * mate whose hello is missing or whose grant expired qualifies; mate merely full is capacity and never does, nor does another
 * card's file lock (the placement view files that wait as peer_unavailable, yet a local author would wait on the same lock).
 */
import { describe, expect, test } from "bun:test";
import { readInventoryQuota, type InventoryQuota, type QuotaReadDeps } from "../src/lib/ai-quota.js";
import { emptyQuotaState } from "../src/lib/quota-state.js";
import { getTask } from "../src/lib/ledger-store.js";
import { assessLocalFallback, localCodexQuotaProof, localFallbackPolicy, planLocalFallback, readLocalFallbackFacts, staleBasis, type EligiblePlan,
  type LocalFallbackFacts, type LocalFallbackPolicyPort } from "../src/lib/recovery-local-fallback-plan.js";
import { blockFixture, E2E_MS, type Fx } from "./scheduler-dispatch-block-helpers.js";

const OK = { ok: true } as const;
const BORROW = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];

/** A build pinned to mate, written in Codex, with this machine's Codex seated; mate has said nothing yet. */
async function pinnedBuild(): Promise<Fx> {
  const p = await blockFixture();
  p.f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
  p.f.db.run("UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate', '$.repo', 'o/r') WHERE id = 'T1'");
  p.policy.remote.agents = { claude: 1, codex: 1 };
  return p;
}

/** T2, a second card of the project, takes a real intent row and the file lock `glob` (T1 drops its own lock on src/lib/x.ts). */
function lockByOtherCard(p: Fx, glob: string) {
  const db = p.f.db;
  const task = db.query("SELECT * FROM tasks WHERE id = 'T1'").get() as Record<string, unknown>;
  const row = { ...task, id: "T2", title: "另一张卡" };
  db.run(`INSERT INTO tasks (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row) as never[]);
  const intent = { ...(db.query("SELECT * FROM scheduler_intents WHERE taskId = 'T1' ORDER BY eventSeq").get() as Record<string, unknown>),
    id: "t2:s1:r0:build:a0", taskId: "T2", status: "submitted" };
  db.run(`INSERT INTO scheduler_intents (${Object.keys(intent).join(",")}) VALUES (${Object.keys(intent).map(() => "?").join(",")})`, Object.values(intent) as never[]);
  db.run("DELETE FROM scheduler_resources WHERE taskId = 'T1' AND resource = 'src/lib/x.ts'");
  db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T2', ?, 1, 'intent')", [glob, intent.id]);
}

const on: LocalFallbackPolicyPort = () => ({ mode: "on", manualAfterMs: null });

const facts = (p: Fx): LocalFallbackFacts =>
  readLocalFallbackFacts(p.f.db, getTask(p.f.db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: p.policy.remote, borrow: BORROW } },
    { slot: OK, quota: OK });

describe("FB2P policy port (CFG's recoveryPolicy narrowed to localFallback)", () => {
  test("no reader observes with a null threshold; throwing or garbage is off with a diagnosis; the mechanism asked is localFallback", () => {
    expect(localFallbackPolicy(undefined, "p")).toMatchObject({ mode: "observe", manualAfterMs: null, diag: expect.any(String) });
    expect(localFallbackPolicy(() => { throw new Error("config corrupt"); }, "p")).toMatchObject({ mode: "off", diag: expect.stringContaining("config corrupt") });
    expect(localFallbackPolicy(() => ({ mode: "maybe" }) as never, "p")).toMatchObject({ mode: "off", diag: expect.any(String) });
    expect(localFallbackPolicy(() => ({ mode: "on", manualAfterMs: -5 }), "p").mode).toBe("off");
    const asked: string[] = [];
    expect(localFallbackPolicy((project, mech) => (asked.push(`${project}/${mech}`), { mode: "on", manualAfterMs: 60_000 }), "p"))
      .toEqual({ mode: "on", manualAfterMs: 60_000, diag: null });
    expect(asked).toEqual(["p/localFallback"]);
  });

  test("on returns the plan, observe wraps the same plan for the record only, off / broken reader block with the diagnosis", async () => {
    const p = await pinnedBuild();
    try {
      const f = facts(p);
      const on = planLocalFallback(f, () => ({ mode: "on", manualAfterMs: null })) as EligiblePlan;
      expect(on).toMatchObject({ kind: "eligible", role: "write", trigger: { kind: "peer_unavailable" } });
      expect(planLocalFallback(f, () => ({ mode: "observe", manualAfterMs: null }))).toEqual({ kind: "observe", key: on.key, would: on, diag: null });
      expect(planLocalFallback(f, undefined)).toMatchObject({ kind: "observe", would: on, diag: expect.stringContaining("observe") });
      expect(planLocalFallback(f, () => ({ mode: "off", manualAfterMs: null }))).toMatchObject({ kind: "blocked", code: "policy_off" });
      const broken: LocalFallbackPolicyPort = () => { throw new Error("EACCES scheduler.json"); };
      expect(planLocalFallback(f, broken)).toMatchObject({ kind: "blocked", code: "policy_off", diag: expect.stringContaining("EACCES") });
      // Observe of a blocked case stays blocked inside: observing never upgrades a refusal.
      p.policy.remote.agents = { claude: 1, codex: 0 };
      expect(planLocalFallback(facts(p), undefined)).toMatchObject({ kind: "observe", would: { kind: "blocked", code: "no_grant" } });
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2P peer_unavailable trigger", () => {
  test("pinned peer without a hello or with an expired grant qualifies; the same peer merely full is capacity, not a takeover", async () => {
    const p = await pinnedBuild();
    try {
      const nohello = assessLocalFallback(facts(p)) as EligiblePlan;
      expect(nohello).toMatchObject({ kind: "eligible", role: "write", trigger: { kind: "peer_unavailable", reason: expect.stringContaining("没有 hello") },
        preserve: { head: null, round: 0 } });
      // No write lease and no order: nothing to end first.
      expect(nohello.steps.map((s) => s.op)).toEqual(["revalidate", "bind_local_author", "dispatch_work", "independent_review"]);
      p.hello({ codex: { total: 2, busy: 2 }, claude: { total: 0, busy: 0 } });
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "not_candidate", reasons: [expect.stringContaining("capacity")] });
      p.hello(undefined, { until: p.f.tickDeps.now() - 1 });
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "eligible", trigger: { reason: expect.stringContaining("授权已到期") } });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("peer healthy but another card holds the file lock: the planner's placement wait is no takeover (local waits on it too)", async () => {
    const p = await pinnedBuild();
    try {
      p.hello();
      lockByOtherCard(p, "src/lib/*.ts");
      const f = facts(p);
      expect(f.decision).toMatchObject({ kind: "wait", code: "placement", reason: "文件锁被别的卡占着" });
      expect(assessLocalFallback(f)).toMatchObject({ kind: "blocked", code: "lock_busy", reasons: [expect.stringContaining("src/lib/*.ts@T2")] });
      expect(planLocalFallback(f, on)).toMatchObject({ kind: "blocked", code: "lock_busy" });
      // An unrelated lock of T2 leaves T1 free again: mate is healthy, so it is plain dispatch, not a takeover.
      p.f.db.run("UPDATE scheduler_resources SET resource = 'docs/*.md' WHERE taskId = 'T2'");
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "not_candidate" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("peer gone but the file locked by another card: still lock_busy; an old no-hello plan is void once mate is back and T2 locks the file", async () => {
    const p = await pinnedBuild();
    try {
      const first = assessLocalFallback(facts(p)) as EligiblePlan;
      expect(first).toMatchObject({ kind: "eligible", basis: { locks: [] } });
      lockByOtherCard(p, "src/lib/*.ts");
      // No hello at all: the trigger stands, the lock alone blocks.
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "lock_busy" });
      expect(staleBasis(first.basis, facts(p), on)).toEqual(expect.arrayContaining(["locks", "eligibility"]));
      p.hello();
      const fresh = facts(p);
      expect(fresh.decision).toMatchObject({ kind: "wait", code: "placement", reason: "文件锁被别的卡占着" });
      expect(assessLocalFallback(fresh).kind).toBe("blocked");
      const stale = staleBasis(first.basis, fresh, on);
      expect(stale).toEqual(expect.arrayContaining(["locks", "eligibility"]));
      // The lock released (T2 done): mate is healthy, so the old plan is still void — now as plain dispatch.
      p.f.db.run("DELETE FROM scheduler_resources WHERE taskId = 'T2'");
      expect(staleBasis(first.basis, facts(p), on)).toEqual(expect.arrayContaining(["eligibility"]));
    } finally { p.f.close(); }
  }, E2E_MS);

  test("an unparseable file scope can never be locked, so it is no takeover either", async () => {
    const p = await pinnedBuild();
    try {
      p.f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["../escape.ts"]')) WHERE id = 'T1'`);
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "lock_busy", reasons: [expect.stringContaining("无法加锁")] });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a Claude-written card is not handed to a local Codex (no model switch)", async () => {
    const p = await pinnedBuild();
    try {
      p.f.db.run("UPDATE task_workflows SET authorFamily = 'claude' WHERE taskId = 'T1'");
      expect(assessLocalFallback(facts(p))).toMatchObject({ kind: "blocked", code: "family_switch" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2P Codex quota proof (existing quota reader + line)", () => {
  const quota = (usedPct: number | null, status: InventoryQuota["status"] = "known"): InventoryQuota => ({ status, source: "live", observedAt: 1, plan: null,
    reason: status === "known" ? null : "没有快照", windows: [{ id: "weekly", kind: "weekly", usedPct, resetsAtMs: null, resetPassed: false }] });

  test("only a known snapshot under the line proves quota; unknown or unreadable is no proof (unlike the scheduling gate)", async () => {
    expect(await localCodexQuotaProof(async () => quota(10))).toEqual({ ok: true });
    expect(await localCodexQuotaProof(async () => quota(99))).toMatchObject({ ok: false, why: expect.stringContaining("weekly") });
    expect(await localCodexQuotaProof(async () => quota(null, "unknown"))).toMatchObject({ ok: false, why: expect.stringContaining("未知") });
    expect(await localCodexQuotaProof(async () => { throw new Error("keychain locked"); })).toMatchObject({ ok: false, why: expect.stringContaining("keychain") });
  });

  test("the real reader: a known 5h window beside an unknown / reset-passed / missing weekly window is no proof", async () => {
    const NOW = Date.UTC(2026, 9, 5, 6, 0), H = 3600_000;
    type W = { id: string; windowMinutes: number; pct: number | null; resetsAtMs: number; resetPassed: boolean };
    const read = (windows: W[]) => async () => (await readInventoryQuota({ now: NOW, enabled: () => true, loadState: async () => emptyQuotaState(),
      claudeCache: () => null, codexRollout: async () => ({ source: "codex-rollout", plan: "prolite", credits: null, limitReached: null,
        observedAt: NOW - 6 * 24 * H, sessionId: "s", cwd: null, agent: null, windows: windows.map((w) => ({ ...w, resets: "" })) }) } as QuotaReadDeps)).codex;
    const session: W = { id: "5h", windowMinutes: 300, pct: 20, resetsAtMs: NOW + 2 * H, resetPassed: false };
    const resetWeekly = read([session, { id: "7d", windowMinutes: 10080, pct: 30, resetsAtMs: NOW - H, resetPassed: false }]);
    const q = await resetWeekly();
    expect(q.status).toBe("known");
    expect(q.windows.find((w) => w.kind === "weekly")).toMatchObject({ usedPct: null, resetPassed: true });
    expect(await localCodexQuotaProof(resetWeekly, NOW)).toMatchObject({ ok: false, why: expect.stringContaining("7d") });
    expect(await localCodexQuotaProof(read([session]), NOW)).toMatchObject({ ok: false, why: expect.stringContaining("周额度") });
    expect(await localCodexQuotaProof(read([session, { id: "7d", windowMinutes: 10080, pct: 30, resetsAtMs: NOW + 24 * H, resetPassed: false }]), NOW))
      .toEqual({ ok: true });
    // A window whose reset time has come since the snapshot is unconfirmed too, even if the reader still shows a number.
    expect(await localCodexQuotaProof(async () => ({ ...quota(10), windows: [{ id: "weekly", kind: "weekly", usedPct: 10, resetsAtMs: 5, resetPassed: false }] }), 10))
      .toMatchObject({ ok: false });
  });
});

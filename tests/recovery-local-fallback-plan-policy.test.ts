/**
 * dispatch-recovery-FB2P, second half: the policy port (on / observe / off, missing, throwing, garbage), the Codex quota proof
 * built on the existing quota reader, and the "no peer it may safely go to" trigger on a real temp ledger — a build pinned to
 * mate whose hello is missing or whose grant expired qualifies; mate merely full is capacity and never does.
 */
import { describe, expect, test } from "bun:test";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { getTask } from "../src/lib/ledger-store.js";
import { assessLocalFallback, localCodexQuotaProof, localFallbackPolicy, planLocalFallback, readLocalFallbackFacts, type EligiblePlan,
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
});

/**
 * dispatch-recovery-PRIVPLACE1: a card in another repository (a private repository in the shared pool) is reviewed and written
 * by peers only — this machine's reviewer and author directories come from repoDir, which has no checkout of it. Real ledger,
 * real autoSnapshot → planScheduler; "before" is the same snapshot without its `projectRepo` fact (no verdict = the old path).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prCoordinates } from "../src/lib/card-repo.js";
import { holdWriteLease, writeOfferBranch } from "../src/lib/ledger-lend-lease.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { explainPlacement, remoteWork } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const PROJECT_REPO = "o/r", PRIVATE_REPO = "floka-ai/cloud";
const PRIVATE_PR = `https://github.com/${PRIVATE_REPO}/pull/17`, PUBLIC_PR = `https://github.com/${PROJECT_REPO}/pull/7`;
const UNIFIED: RemotePolicy = { agents: { claude: 2, codex: 2 }, mode: "balance", roles: [], poolTimeoutMin: 15 };
// Old path: this machine on tier `first`, so a review / write with local room stays here before the fix.
const LEGACY: RemotePolicy = { mode: "balance", roles: ["review", "write"], localPriority: "first", poolTimeoutMin: 15 };
const BORROW: BorrowEntry[] = [{ peer: "mate", projects: ["p"], maxOpen: 5, roles: ["review", "write"] }];
const ONLY_PEER = "只派给 peer";
const FP = "abcd-ef01-2345-6789";

type Fixture = ReturnType<typeof autoFixture>;
let f: Fixture;
let seq = 0;
beforeEach(() => { f = autoFixture(); setForeignRepoLookupForTest({ project: (p) => (p === "p" ? PROJECT_REPO : null) }); });
afterEach(() => { f.close(); setForeignRepoLookupForTest({ project: null, origin: null }); });

/** The peer's hello: `busy` per family out of 5 (5 = full). */
function hello(busy: { claude: number; codex: number }): void {
  const now = f.tickDeps.now();
  recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "b", seq: ++seq, paused: null,
    slots: { claude: { total: 5, busy: busy.claude }, codex: { total: 5, busy: busy.codex } },
    grant: { until: now + 10_000_000, repos: [PRIVATE_REPO, PROJECT_REPO], roles: ["review", "write"], ordersPerDay: 50, ordersLeftToday: 50 } }, now);
}

const snap = (remote: RemotePolicy): PlannerSnapshot =>
  autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: { remote, borrow: BORROW } });
/** The same snapshot without the repository fact: what the planner did before PRIVPLACE1. */
const before = (s: PlannerSnapshot): PlannerSnapshot => { const { projectRepo: _, ...rest } = s; return rest as PlannerSnapshot; };
const card = (stage: string, pr: string | null, extra: Record<string, unknown> = {}) =>
  f.db.query("UPDATE tasks SET stage=?, headSHA=?, pr=?, extra=json_patch(extra, ?) WHERE id='T1'").run(stage, H1, pr, JSON.stringify(extra));
const recipient = (d: PlannerDecision) => (d.kind === "intent" ? d.recipient : null);
const localish = (d: PlannerDecision) => d.kind === "intent" && (d.action === "ensure_session" || !String(d.recipient).startsWith("peer:"));

describe("[验收线 1] review of a private card goes to a peer, or waits", () => {
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement (no remote.agents)", LEGACY]] as const) {
    test(`${name}: local reviewer room → peer:mate with the card's repo and PR; peers full → wait, no local reviewer`, () => {
      card("review", PRIVATE_PR);
      hello({ claude: 0, codex: 1 }); // peer has room but carries more load than this machine
      const s = snap(remote);
      expect(s.projectRepo).toBe(PROJECT_REPO);
      expect(localish(planScheduler(before(s)))).toBe(true); // red before: the same input went local
      const d = planScheduler(s);
      expect(d).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
      expect(s.pool?.repo).toBe(PRIVATE_REPO); // the pool order's coordinates (ledger-scheduler-pool.ts prCoordinates)
      expect(prCoordinates(f.task().pr)).toEqual({ repo: PRIVATE_REPO, pr: 17 });

      hello({ claude: 5, codex: 5 });
      const full = planScheduler(snap(remote));
      expect(full).toMatchObject({ kind: "wait", code: "placement" });
      expect(full.kind === "wait" && full.reason).toContain(ONLY_PEER);
      expect(full.kind === "wait" && full.reason).toContain(PRIVATE_REPO);
    });
  }

  test("old path with no peers borrowed at all still waits instead of a local reviewer", () => {
    card("review", PRIVATE_PR);
    const s = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: { remote: LEGACY, borrow: [] } });
    expect(localish(planScheduler(before(s)))).toBe(true);
    expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: expect.stringContaining(ONLY_PEER) });
  });
});

describe("[验收线 2] a bound local reviewer is not kept for a private card", () => {
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement", LEGACY]] as const) {
    test(`${name}: the next review round is pooled, not sent to the bound reviewer`, () => {
      card("review", PRIVATE_PR);
      f.db.run("PRAGMA foreign_keys=OFF");
      f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES ('T1', 'reviewer', 'agent-rv-t1', 's-rv', 'codex', 'acp', 'active', 'i', 0, 0)`).run();
      hello({ claude: 0, codex: 0 });
      const s = snap(remote);
      expect(s.reviewer?.agent).toBe("agent-rv-t1");
      expect(planScheduler(before(s))).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
      expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    });
  }
});

describe("[验收线 2] old path: a bound local reviewer does not block a proto-1 peer", () => {
  test("idle proto-1 peer, private review card with an active local reviewer → peer:mate, binding kept on the ledger", () => {
    card("review", PRIVATE_PR);
    const unbound = planScheduler(snap(LEGACY)); // no hello: mate is a proto-1 peer
    expect(unbound).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    f.db.run("PRAGMA foreign_keys=OFF");
    f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('T1', 'reviewer', 'agent-rv-t1', 's-rv', 'codex', 'acp', 'active', 'i', 0, 0)`).run();
    const s = snap(LEGACY);
    expect(s.reviewer?.agent).toBe("agent-rv-t1");
    expect(planScheduler(before(s))).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" }); // red before
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
  });
});

describe("[验收线 3] writing a private card goes to a peer, or waits; pinned here escalates", () => {
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement", LEGACY]] as const) {
    test(`${name}: build with local and peer room → peer; peers full → wait, no local author`, async () => {
      await f.tick(); // bind the local author (spec)
      f.db.query("UPDATE scheduler_intents SET status='done'").run();
      card("build", PRIVATE_PR);
      hello({ claude: 1, codex: 1 });
      const s = snap(remote);
      expect(localish(planScheduler(before(s)))).toBe(true);
      expect(recipient(planScheduler(s))).toBe("peer:mate");

      hello({ claude: 5, codex: 5 });
      const full = planScheduler(snap(remote));
      expect(full).toMatchObject({ kind: "wait", reason: expect.stringContaining(ONLY_PEER) });
    });

    test(`${name}: fix with the peer's write lease → that peer, and its order can be cut; peers full → wait`, async () => {
      await f.tick();
      f.db.query("UPDATE scheduler_intents SET status='done'").run();
      card("fix", PRIVATE_PR);
      f.db.query("UPDATE tasks SET branch=? WHERE id='T1'").run(lendBranch("T1", FP));
      holdWriteLease(f.db, f.task(), { peer: "mate", fp: FP, branch: lendBranch("T1", FP)!, repo: PRIVATE_REPO }, 1);
      hello({ claude: 1, codex: 1 });
      const s = snap(remote);
      expect(s.pool?.writeLeasePeer).toBe("mate");
      expect(remoteWork(s, 0, "fix")).toMatchObject({ peer: "mate" });
      expect(explainPlacement(s)).toMatchObject({ where: "peer:mate" });
      // The pool step's own gate accepts this fix order for that peer (ledger-lend-lease.ts writeOfferBranch).
      expect(writeOfferBranch(f.db, f.task(), "fix", "mate", { fp: FP, base: "main", baseSha: null, report: null })).toBe(lendBranch("T1", FP)!);
      hello({ claude: 5, codex: 5 });
      expect(remoteWork(snap(remote), 0, "fix")).toMatchObject({ wait: expect.stringContaining(ONLY_PEER) });
    });

    test(`${name}: fix no peer holds the write lease of → escalate once, no pool order, no local author`, async () => {
      await f.tick();
      f.db.query("UPDATE scheduler_intents SET status='done'").run();
      card("fix", PRIVATE_PR);
      hello({ claude: 0, codex: 0 });
      const s = snap(remote);
      expect(s.pool?.writeLeasePeer ?? null).toBeNull();
      expect(remoteWork(before(s), 0, "fix")).toBeNull(); // red before: the local executor writes it in repoDir
      // No peer could take it: the pool step refuses a lease-less fix for any peer.
      expect(() => writeOfferBranch(f.db, f.task(), "fix", "mate", { fp: FP, base: "main", baseSha: null, report: null })).toThrow("写租约");
      const away = remoteWork(s, 0, "fix");
      const why = away && "escalate" in away ? away.escalate : "";
      expect(why).toContain("没有 peer 写租约");
      expect(why).toContain(PRIVATE_REPO);
      expect(explainPlacement(s)).toMatchObject({ where: "-", reason: expect.stringContaining("交 PM") });
      expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "placement_lease" });
    });

    test(`${name}: a private card pinned to this machine escalates, no session, no intent`, () => {
      card("build", PRIVATE_PR, { placement: "local" });
      hello({ claude: 0, codex: 0 });
      const s = snap(remote);
      expect(s.author).toBeNull();
      expect(planScheduler(before(s))).toMatchObject({ kind: "intent", action: "ensure_session" });
      const d = planScheduler(s);
      expect(d).toMatchObject({ kind: "escalate", code: "placement_lease" });
      expect(d.kind === "escalate" && d.reason).toContain(PRIVATE_REPO);
      expect(d.kind === "escalate" && d.reason).toContain("固定在本机");
    });

    test(`${name}: build with no usable file scope escalates, no local author session`, () => {
      for (const globs of [[], ["../x"]]) {
        card("build", PRIVATE_PR, { fileGlobs: globs });
        hello({ claude: 0, codex: 0 });
        const s = snap(remote);
        expect(s.author).toBeNull();
        if (!globs.length) expect(planScheduler(before(s))).toMatchObject({ kind: "intent", action: "ensure_session" }); // red before: local author (invalid globs already waited in the pool)
        const d = planScheduler(s);
        expect(d.kind === "escalate" ? [d.code, d.reason.includes(PRIVATE_REPO), d.reason.includes("文件范围")] : d).toEqual(["placement_lease", true, true]);
      }
    });

    test(`${name}: spec stage of an unpinned private card escalates (no peer takes a restate)`, () => {
      card("spec", PRIVATE_PR);
      hello({ claude: 0, codex: 0 });
      const d = planScheduler(snap(remote));
      expect(d).toMatchObject({ kind: "escalate", code: "placement_lease", reason: expect.stringContaining("start_node 固定放到 peer") });
    });
  }
});

describe("[验收线 4] coexistence: non-private cards and an unknown project repository plan as before", () => {
  const variants: [string, string | null, Record<string, unknown>][] = [
    ["PR in the project repository", PUBLIC_PR, {}],
    ["no PR, extra.repo = project repository", null, { repo: PROJECT_REPO }],
    ["neither", null, {}],
  ];
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement", LEGACY]] as const) {
    for (const [what, pr, extra] of variants) {
      test(`${name} · ${what}: review / build / fix decisions word for word`, async () => {
        await f.tick();
        f.db.query("UPDATE scheduler_intents SET status='done'").run();
        hello({ claude: 0, codex: 1 });
        for (const stage of ["review", "build", "fix", "spec"]) {
          card(stage, pr, extra);
          const s = snap(remote);
          expect(s.projectRepo).toBe(PROJECT_REPO);
          expect(planScheduler(s)).toEqual(planScheduler(before(s)));
          expect(explainPlacement(s)).toEqual(explainPlacement(before(s)));
        }
      });
    }

    test(`${name}: projectRepo unreadable (null) → a private card takes the old path`, async () => {
      await f.tick();
      f.db.query("UPDATE scheduler_intents SET status='done'").run();
      setForeignRepoLookupForTest({ project: () => null });
      hello({ claude: 1, codex: 1 });
      for (const stage of ["review", "build"]) {
        card(stage, PRIVATE_PR);
        const s = snap(remote);
        expect(s.projectRepo).toBeNull();
        expect(planScheduler(s)).toEqual(planScheduler(before(s)));
        expect(localish(planScheduler(s))).toBe(true);
      }
    });
  }
});

describe("[验收线 5] a local-only security card that is also private waits on the rule conflict", () => {
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement", LEGACY]] as const) {
    test(`${name}: wait naming both rules, no review sent, no local reviewer`, () => {
      f.db.query("UPDATE task_workflows SET template='security' WHERE taskId='T1'").run();
      card("review", PRIVATE_PR);
      hello({ claude: 0, codex: 0 });
      const s = snap(remote);
      expect(s.securityPool ?? "off").not.toBe("on");
      const d = planScheduler(s);
      expect(d).toMatchObject({ kind: "wait" });
      expect(d.kind === "wait" && d.reason).toContain("两条规则冲突");
      expect(d.kind === "wait" && d.reason).toContain(PRIVATE_REPO);
      expect(planScheduler(snap(remote))).toEqual(d); // one stable reason: one wait, not a new one per pass
    });
  }
});

describe("[验收线 5] a retired local reviewer is not rebuilt here for a private card", () => {
  const retire = () => insertEvent(f.db, { actor: "scheduler", now: f.tickDeps.now() }, { project: "p", target: "T1", kind: "scheduler", text: "退役",
    data: { op: "reviewer_swap", legacy: true, intentId: "old", sessionId: "s-rv" } }, true);
  for (const [name, remote] of [["unified pool", UNIFIED], ["old placement", LEGACY]] as const) {
    for (const template of ["security", "code"] as const) {
      test(`${name} · ${template}: legacy retirement, no active reviewer → security waits / code escalates, no local ensure_session`, () => {
        f.db.query("UPDATE task_workflows SET template=? WHERE taskId='T1'").run(template);
        card("review", PRIVATE_PR);
        hello({ claude: 0, codex: 0 });
        retire();
        const s = snap(remote);
        expect(s.reviewer).toBeNull();
        expect(planScheduler(before(s))).toMatchObject({ kind: "intent", action: "ensure_session" }); // red before
        const d = planScheduler(s);
        expect(d).toMatchObject(template === "security" ? { kind: "wait", code: "placement" } : { kind: "escalate", code: "foreign_repo" });
        const why = d.kind === "wait" || d.kind === "escalate" ? d.reason : "";
        expect(why).toContain(PRIVATE_REPO);
        expect(why).toContain(template === "security" ? "两条规则冲突" : "请 PM 定向派审");
      });
    }
  }
});

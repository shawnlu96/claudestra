import { expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { explainPlacement } from "../src/lib/scheduler-placement-plan.js";

type Fixture = Awaited<ReturnType<typeof fourRoundFix>>;
const reclaimEvent = (f: Fixture) => listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "fix_strategy_reclaim");

function pin(f: Fixture, placement: string | null): Record<string, unknown> {
  const extra: Record<string, unknown> = { ...f.task().extra, repo: "o/r", keep: { nested: [1, "x"] } };
  if (placement !== null) extra.placement = placement;
  f.db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [JSON.stringify(extra)]);
  return extra;
}

/** The planner's view with Peer still offering codex write slots, as the 10-11 incident had. */
function poolOpts(f: Fixture) {
  return { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: {
    remote: { mode: "balance" as const, roles: ["write" as const, "review" as const], poolTimeoutMin: 15, repo: "o/r" },
    borrow: [{ peer: "Peer", projects: ["p"], roles: ["write" as const, "review" as const], maxOpen: 8 }] } };
}

test("CONV2 reclaim drops the pin on the reclaimed peer in the same transaction; the next plan dispatches the fix to the local new-family author", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f); peerAuthor(f, "claude");
    const intent = p.plan(), before = pin(f, "peer:Peer");
    const prev = heldLease(f.db, f.task())!;
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(heldLease(f.db, f.task())).toBeNull();
    const { placement: _, ...rest } = before;
    expect(f.task().extra).toEqual(rest);
    expect(reclaimEvent(f)?.data).toMatchObject({ intentId: intent.id, peer: "Peer", unpinned: "peer:Peer" });
    expect(prev.prevAssigneeKind).toBe("agent");
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(author.family).toBe("codex");
    const snapshot = autoSnapshot(f.db, f.task(), poolOpts(f));
    expect(explainPlacement(snapshot).reason).not.toContain("固定");
    const next = planScheduler(snapshot);
    expect(next).toMatchObject({ action: "dispatch", recipient: author.agent });
    expect(JSON.stringify(next)).not.toContain("Peer");
  } finally { f.close(); }
});

for (const placement of ["peer:Other", "local", null] as const) {
  test(`CONV2 reclaim leaves extra byte-for-byte when the pin is ${placement ?? "absent"} and records unpinned null`, async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f, ["Peer", "Other"]); peerAuthor(f, "claude");
      const intent = p.plan(); pin(f, placement);
      const raw = (f.db.query("SELECT extra FROM tasks WHERE id = 'T1'").get() as { extra: string }).extra;
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
      expect((f.db.query("SELECT extra FROM tasks WHERE id = 'T1'").get() as { extra: string }).extra).toBe(raw);
      expect(reclaimEvent(f)?.data).toMatchObject({ intentId: intent.id, unpinned: null });
    } finally { f.close(); }
  });
}

test("assignee restore matches the lease's prior assignee, and an assignee already moved off the peer worker is left alone while the pin still goes", async () => {
  for (const variant of ["restored", "moved"] as const) {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f); peerAuthor(f, "claude");
      const intent = p.plan(); pin(f, "peer:Peer");
      const lease = heldLease(f.db, f.task())!;
      if (variant === "moved") f.db.run("UPDATE tasks SET assigneeKind = 'human', assignee = 'someone', agent = NULL WHERE id = 'T1'");
      const rev = f.task().rev;
      const steps: unknown[] = [];
      const deps = { ...p.deps, manager: async (...a: Parameters<typeof p.deps.manager>) => {
        if (a[0] === "create" && !steps.length) steps.push(f.db.query("SELECT agent, assigneeKind, assignee, extra, rev FROM tasks WHERE id = 'T1'").get());
        return p.deps.manager(...a);
      } };
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, deps)).toMatchObject({ step: "session" });
      const row = steps[0] as { agent: string | null; assigneeKind: string | null; assignee: string | null; extra: string; rev: number };
      expect(JSON.parse(row.extra).placement).toBeUndefined();
      expect(row.rev).toBe(rev + 1);
      expect(row).toMatchObject(variant === "restored"
        ? { agent: lease.prevAssignee, assigneeKind: "agent", assignee: lease.prevAssignee }
        : { agent: null, assigneeKind: "human", assignee: "someone" });
      expect(reclaimEvent(f)?.data).toMatchObject({ unpinned: "peer:Peer", taskRev: rev + 1 });
    } finally { f.close(); }
  }
});

import { describe, expect, test } from "bun:test";
import { notifyQuotaResumeProgress } from "../src/lib/quota-resume-state-notice.js";
import type { Wall, WallRecovery } from "../src/lib/quota-wall.js";
import type { ResumeProgress } from "../src/lib/quota-resume-state.js";

const T0 = Date.parse("2026-10-11T08:00:00Z");
const identity = { sessionId: "session", taskKey: "task-1" };

function rig() {
  let now = T0, ok = true;
  const notices: string[] = [];
  const wall: Wall = { id: "w", enteredAt: T0, source: "api_error", kind: "weekly",
    resetsAt: null, resetsText: null, hits: {}, resumeStates: {},
    recovery: { step: "resume", escSent: [], manual: [], flushed: 0, resumed: [], running: [] } };
  const target = (cid: string, p: ResumeProgress) => {
    wall.hits[cid] = { agent: `agent-${cid}`, at: T0, error: "rate_limit", identity };
    wall.resumeStates![cid] = p;
  };
  const deps = { now: () => now, log: () => {},
    notifyOwner: async (text: string) => { notices.push(text); return ok; } };
  const save = (patch: Partial<WallRecovery>) => { Object.assign(wall.recovery!, patch); return true; };
  return { wall, notices, target, tick: () => notifyQuotaResumeProgress(wall, deps, save),
    advance: (ms: number) => { now += ms; }, fail: (v: boolean) => { ok = !v; } };
}

const pending = (reason: string): ResumeProgress => ({ status: "pending", attempts: 1, offline: true, reason });

describe("[验收线 1] reason flapping with unchanged status is not progress", () => {
  test("five not_delivered/read-failure swings send at most one notice", async () => {
    const r = rig();
    r.target("a", pending("not_delivered"));
    await r.tick();
    for (let i = 0; i < 5; i++) {
      r.advance(301_000);
      r.wall.resumeStates!.a = pending(i % 2 ? "not_delivered" : "identity_unreadable");
      await r.tick();
    }
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("明确未送达：agent-a（a）");
  });
});

describe("[验收线 2] real status changes still notify, spaced by the minimum interval", () => {
  test("cancel and new target each notify, never closer than five minutes", async () => {
    const r = rig();
    r.target("a", pending("not_delivered")); r.target("b", pending("not_delivered"));
    await r.tick(); expect(r.notices).toHaveLength(1);
    r.wall.resumeStates!.a = { status: "cancelled", attempts: 1, reason: "task_finished" };
    r.advance(1_000); await r.tick();
    expect(r.notices).toHaveLength(1);
    r.advance(299_000); await r.tick();
    expect(r.notices).toHaveLength(2);
    expect(r.notices[1]).not.toContain("agent-a");
    r.target("c", pending("not_delivered"));
    r.advance(299_999); await r.tick();
    expect(r.notices).toHaveLength(2);
    r.advance(1); await r.tick();
    expect(r.notices).toHaveLength(3);
    expect(r.notices[2]).toContain("agent-c（c）");
  });
});

describe("[验收线 3] a failed notice retries and does not swallow the change", () => {
  test("failure is retried after backoff and the change is delivered", async () => {
    const r = rig();
    r.target("a", pending("not_delivered"));
    await r.tick();
    r.target("b", { status: "unknown", attempts: 1 });
    r.fail(true); r.advance(300_000); await r.tick();
    expect(r.notices).toHaveLength(2);
    r.fail(false); r.advance(1_000); await r.tick();
    expect(r.notices).toHaveLength(2);
    r.advance(299_000); await r.tick();
    expect(r.notices).toHaveLength(3);
    expect(r.notices[2]).toContain("可能已送达：agent-b（b）");
    r.advance(300_000); await r.tick();
    expect(r.notices).toHaveLength(3);
  });
});

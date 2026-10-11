import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaResumePort, quotaResumeWanted } from "../src/bridge/quota-wall-wiring.js";
import type { Envelope } from "../src/bridge/router.js";
import type { ResumeTarget } from "../src/lib/quota-resume-state.js";
import { createQuotaWall, type QuotaWallDeps } from "../src/bridge/quota-wall.js";
import { emptyWallState, type WallState } from "../src/lib/quota-wall.js";

const T0 = Date.parse("2026-10-11T06:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "qresume-synthetic-"));
  dirs.push(dir);
  const path = join(dir, "wall.json");
  writeFileSync(path, JSON.stringify(emptyWallState()));
  let now = T0;
  const attempts: string[] = [], notices: string[] = [];
  const delivered: Envelope[] = [];
  const online = new Set<string>();
  const sessions = new Map([['a', 'session-a'], ['b', 'session-b']]);
  const finished = new Set<string>(), protectedTargets = new Set<string>();
  let unreadable = false;
  const readTarget = (cid: string): ResumeTarget => {
    if (unreadable) throw new Error("synthetic read failure");
    if (finished.has(cid)) return { kind: "cancelled", reason: "task_finished" };
    if (protectedTargets.has(cid)) return { kind: "unknown", reason: "protected" };
    const sessionId = sessions.get(cid);
    return sessionId ? { kind: "ready", identity: { sessionId, taskKey: "task-1" } } : { kind: "unknown", reason: "missing" };
  };
  const port = quotaResumePort({
    clients: { get: (cid) => online.has(cid) ? { ws: {} as never } : undefined },
    markAgentSource: () => {}, deliver: async (env) => { delivered.push(env); return { envelope: env, outcome: { kind: "sent" } }; },
  }, readTarget);
  const deps: QuotaWallDeps = {
    now: () => now, newId: () => "synthetic-wall",
    load: () => JSON.parse(readFileSync(path, "utf8")) as WallState,
    save: (s) => writeFileSync(path, JSON.stringify(s)),
    isClaudeCode: async () => true, windows: async () => [],
    capture: async () => "", prepare: async () => {}, sendEsc: async () => {},
    mainTurnBusy: async () => false,
    held: { wallCount: () => ({ human: 0, agent: 0 }), queuedFor: () => false, wallChannels: () => [], wakers: () => [], release: () => 0 },
    flush: async () => {},
    resolveTarget: async (cid) => readTarget(cid),
    connected: (cid) => online.has(cid),
    resume: async (...args) => { attempts.push(args[0]); return port(...args); },
    notifyOwner: async (text) => { notices.push(text); return true; },
    probe: async () => null, credits: async () => null, readCache: () => null,
    takeClearRequest: () => false, sleep: async () => {}, log: () => {},
  };
  const wall = createQuotaWall(deps);
  const hit = (cid: string, weekly = true) => wall.noteApiError({ channelId: cid, agent: `agent-${cid}`, at: now,
    error: "rate_limit", text: weekly ? "You've hit your weekly limit" : "You've hit your session limit · resets 11pm (Asia/Shanghai)" });
  return { wall, deps, attempts, notices, online, delivered, readTarget, sessions, finished, protectedTargets, hit,
    disk: deps.load, advance: (ms = 300_000) => { now += ms; }, at: () => now,
    unreadable: (v: boolean) => { unreadable = v; } };
}

describe("[验收线 1] offline recovery persists", () => {
  test("false stays pending; reconnect resumes once without replaying successful targets", async () => {
    const r = rig(); r.online.add("b");
    await r.hit("a"); await r.hit("b"); r.wall.clear(); await r.wall.tick();
    expect(r.attempts).toEqual(["a", "b"]);
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    expect(r.disk().wall!.resumeStates!.a).toMatchObject({ status: "pending", reason: "not_delivered", attempts: 1 });
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
    expect(r.notices.some((n) => n.startsWith("✅"))).toBe(false);
    r.online.add("a"); await r.wall.tick(); await r.wall.tick();
    expect(r.attempts).toEqual(["a", "b", "a"]);
    expect(r.delivered.map((e) => e.to.kind === "local" && e.to.channelId)).toEqual(["b", "a"]);
    expect(r.disk().wall!.recovery!.step).toBe("done");
    expect(r.notices.filter((n) => n.startsWith("✅"))).toHaveLength(1);
  });

  test("restart reads pending target and keeps completed target deduplicated", async () => {
    const r = rig(); r.online.add("b"); await r.hit("a"); await r.hit("b");
    r.wall.clear(); await r.wall.tick();
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    const reboot = createQuotaWall(r.deps); r.online.add("a");
    await reboot.tick(); await reboot.tick();
    expect(r.attempts).toEqual(["a", "b", "a"]);
    expect(r.delivered.map((e) => e.to.kind === "local" && e.to.channelId)).toEqual(["b", "a"]);
    expect(r.disk().wall!.recovery!.step).toBe("done");
  });
});

describe("[验收线 2] target identity and uncertain results", () => {
  test.each(["replacement", "finished"])("%s never receives delayed resume", async (change) => {
    const r = rig(); await r.hit("a"); r.wall.clear(); await r.wall.tick();
    if (change === "replacement") r.sessions.set("a", "new-session"); else r.finished.add("a");
    r.online.add("a"); r.advance(); await r.wall.tick();
    expect(r.attempts).toEqual(["a"]);
    expect(r.disk().wall!.recovery!.step).toBe("done");
  });

  test("identity read failure and protected target remain unresolved", async () => {
    const r = rig(); await r.hit("a"); r.unreadable(true); r.online.add("a");
    r.wall.clear(); await r.wall.tick();
    expect(r.attempts).toEqual([]);
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    r.unreadable(false); r.protectedTargets.add("a"); r.advance(); await r.wall.tick();
    expect(r.attempts).toEqual([]);
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
  });

  test("busy read failure does not prove self-running", async () => {
    const r = rig(); r.online.add("a"); await r.hit("a");
    r.deps.mainTurnBusy = async () => { throw new Error("synthetic busy read failure"); };
    r.wall.clear(); await r.wall.tick();
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    expect(r.disk().wall!.recovery!.running).toEqual([]);
    expect(r.attempts).toEqual([]);
  });

  test("delivery exception is ambiguous, survives restart, and is not blindly retried", async () => {
    const r = rig(); await r.hit("a");
    r.deps.resume = async (cid) => { r.attempts.push(cid); throw new Error("may have sent"); };
    r.wall.clear(); await r.wall.tick(); r.advance(); await createQuotaWall(r.deps).tick();
    expect(r.attempts).toEqual(["a"]);
    expect(r.disk().wall!.resumeStates!.a.status).toBe("unknown");
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
  });

  test.each(["held", "running"])("%s is terminal and never replayed", async (mode) => {
    const r = rig(); await r.hit("a");
    if (mode === "held") r.deps.resume = async (cid) => { r.attempts.push(cid); return "held"; };
    else r.deps.mainTurnBusy = async () => true;
    r.wall.clear(); await r.wall.tick(); r.advance(); await createQuotaWall(r.deps).tick();
    expect(r.disk().wall!.recovery!.step).toBe("done");
    expect(r.attempts).toEqual(mode === "held" ? ["a"] : []);
  });
});

describe("[验收线 3] probe must observe the blocking window", () => {
  test.each([true, false])("weekly=%s ignores only the other low window", async (weekly) => {
    const r = rig(); await r.hit("a", weekly); r.advance();
    r.deps.probe = async () => ({ pct: 10, sessionPct: weekly ? 10 : null, weekPct: weekly ? null : 10, observedAt: r.at() });
    await r.wall.tick();
    expect(r.wall.active()).toBe(true);
    r.advance();
    r.deps.probe = async () => ({ pct: 100, sessionPct: weekly ? 100 : 10, weekPct: weekly ? 10 : 100, observedAt: r.at() });
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("probe");
  });
});

describe("[验收线 2] durable production plans", () => {
  test("a held envelope carries identity through serialization and rejects changed session or finished task", async () => {
    const r = rig(); r.online.add("a"); await r.hit("a"); r.wall.clear(); await r.wall.tick();
    const env = JSON.parse(JSON.stringify(r.delivered[0])) as Envelope;
    expect(env.meta.expectSession).toBe("session-a");
    expect(quotaResumeWanted(env, r.readTarget)).toBe(true);
    r.sessions.set("a", "replacement");
    expect(quotaResumeWanted(env, r.readTarget)).toBe(false);
    r.sessions.set("a", "session-a"); r.finished.add("a");
    expect(quotaResumeWanted(env, r.readTarget)).toBe(false);
    r.finished.clear(); r.protectedTargets.add("a");
    expect(quotaResumeWanted(env, r.readTarget)).toBe(false);
  });

  test("old done + notified without a delivery result is repaired conservatively on restart", async () => {
    const r = rig(); await r.hit("a"); r.wall.clear();
    const disk = r.disk(); disk.wall!.recovery!.step = "done"; disk.wall!.recoveredNotifiedAt = T0;
    delete disk.wall!.hits.a!.identity; r.deps.save(disk);
    const reboot = createQuotaWall(r.deps); r.online.add("a"); await reboot.tick();
    expect(r.attempts).toEqual([]);
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    expect(r.disk().wall!.resumeStates!.a.reason).toBe("unbound_hit");
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
  });

  test("persisted sending before a crash stays ambiguous rather than resending", async () => {
    const r = rig(); await r.hit("a"); r.wall.clear();
    const disk = r.disk(); disk.wall!.recovery!.step = "resume";
    disk.wall!.resumeStates = { a: { status: "sending", attempts: 1, messageId: "crash" } }; r.deps.save(disk);
    r.online.add("a"); await createQuotaWall(r.deps).tick();
    expect(r.attempts).toEqual([]);
    expect(r.disk().wall!.resumeStates!.a.status).toBe("unknown");
    expect(r.disk().wall!.recovery!.step).toBe("resume");
  });

  test("identity change while probing busy cancels rather than settling the replacement as self-running", async () => {
    const r = rig(); await r.hit("a");
    r.deps.mainTurnBusy = async () => { r.sessions.set("a", "replacement"); return true; };
    r.wall.clear(); await r.wall.tick();
    expect(r.attempts).toEqual([]);
    expect(r.disk().wall!.resumeStates!.a.status).toBe("cancelled");
    expect(r.disk().wall!.recovery!.running).toEqual([]);
  });

  test("offline backoff is bounded and tick does not retry before its persisted deadline", async () => {
    const r = rig(); await r.hit("a"); r.wall.clear(); await r.wall.tick();
    await r.wall.tick(); expect(r.attempts).toEqual(["a"]);
    for (let i = 0; i < 8; i++) {
      const before = r.disk().wall!.resumeStates!.a;
      const wait = before.nextAt! - r.at(); expect(wait).toBeLessThanOrEqual(300_000);
      r.advance(wait); await r.wall.tick();
    }
    expect(r.attempts).toHaveLength(9);
    expect(r.disk().wall!.resumeStates!.a.nextAt! - r.at()).toBe(300_000);
  });

  test("production delivery distinguishes acknowledged held, explicit dropped and uncertain transport error", async () => {
    const identity = { sessionId: "synthetic-session", taskKey: "synthetic-task" };
    for (const kind of ["held", "dropped", "error"] as const) {
      const port = quotaResumePort({ clients: { get: () => ({ ws: {} as never }) }, markAgentSource: () => {},
        deliver: async (env) => ({ envelope: env, outcome: kind === "held" ? { kind: "sent", heldBy: "wall_menu" }
          : kind === "dropped" ? { kind: "dropped", reason: "offline" } : { kind: "error", error: new Error("transport unknown") } }),
      }, () => ({ kind: "ready", identity }));
      expect(await port("a", "agent-a", "continue", false, { identity, messageId: "synthetic-plan" }))
        .toBe(kind === "held" ? "held" : kind === "dropped" ? false : "unknown");
    }
  });
});

test("[验收线 2] explicit undelivered and possibly delivered targets stay separate", async () => {
  const r = rig(); await r.hit("a"); await r.hit("b");
  const resume = r.deps.resume;
  r.deps.resume = async (...args) => { if (args[0] === "b") throw new Error("synthetic unknown outcome"); return resume(...args); };
  r.wall.clear(); await r.wall.tick();
  expect(r.disk().wall!.resumeStates!.a.status).toBe("pending");
  expect(r.disk().wall!.resumeStates!.b.status).toBe("unknown");
  r.online.add("a"); r.advance(); await createQuotaWall(r.deps).tick();
  expect(r.disk().wall!.resumeStates!.a.status).toBe("sent");
  expect(r.disk().wall!.resumeStates!.b.status).toBe("unknown");
  expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
});

describe("[验收线 2] review regressions: unresolved recovery remains observable", () => {
  test.each(["unknown", "unbound"])("%s notifies separately, backs off across restart and permits new cache walls", async (mode) => {
    const r = rig(); await r.hit("a"); await r.hit("b");
    if (mode === "unknown") r.deps.resume = async (cid) => { r.attempts.push(cid); return cid === "a" ? "unknown" : false; };
    else {
      const disk = r.disk(); delete disk.wall!.hits.a!.identity; r.deps.save(disk);
    }
    // Seed a reset baseline so an advanced cache period is independently eligible to re-enter.
    const disk = r.disk(); disk.wall!.resetsAt = T0 + 3_600_000; r.deps.save(disk);
    const wall = createQuotaWall(r.deps); wall.clear(); await wall.tick();
    expect(r.notices.join("\n")).toContain(mode === "unknown" ? "可能已送达：agent-a" : "身份待核：agent-a");
    expect(r.notices.join("\n")).toContain("明确未送达：agent-b");
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
    expect(r.disk().wall!.recovery!.step).toBe("resume");
    const state = r.disk().wall!.resumeStates!.a;
    expect(state.nextAt).toBeGreaterThan(r.at());
    let reads = 0, writes = 0;
    const resolve = r.deps.resolveTarget!, save = r.deps.save;
    r.deps.resolveTarget = async (...args) => { reads++; return resolve(...args); };
    r.deps.save = (s) => { writes++; save(s); };
    const reboot = createQuotaWall(r.deps);
    r.advance(1_000); await reboot.tick();
    expect(reads).toBe(0); expect(writes).toBe(0); expect(r.notices).toHaveLength(1);
    r.deps.readCache = () => ({ weekPct: 100, sessionPct: 10, scrapedAt: r.at(),
      weekResetsAtMs: T0 + 7_200_000, sessionResetsAtMs: null });
    await reboot.tick();
    expect(reboot.active()).toBe(true);
    expect(r.disk().wall!.source).toBe("usage_cache");
    expect(r.disk().wall!.hits.a).toBeDefined();
    expect(r.disk().wall!.resumeStates!.a).toEqual(state);
  });

  test("unknown delivery can settle on genuine self-running with the original identity", async () => {
    const r = rig(); await r.hit("a");
    r.deps.resume = async (cid) => { r.attempts.push(cid); return "unknown"; };
    r.wall.clear(); await r.wall.tick();
    r.deps.mainTurnBusy = async () => true;
    r.advance(); await createQuotaWall(r.deps).tick();
    expect(r.attempts).toEqual(["a"]);
    expect(r.disk().wall!.resumeStates!.a.status).toBe("running");
    expect(r.disk().wall!.recovery!.step).toBe("done");
    expect(r.notices.filter((n) => n.startsWith("✅"))).toHaveLength(1);
  });

  test("uncertain delivery remains uncertain when the second identity read fails, with bounded backoff", async () => {
    const r = rig(); await r.hit("a");
    r.deps.resume = async (cid) => { r.attempts.push(cid); return "unknown"; };
    r.wall.clear(); await r.wall.tick();
    r.deps.mainTurnBusy = async () => { r.unreadable(true); return false; };
    r.advance(); await r.wall.tick();
    expect(r.disk().wall!.resumeStates!.a.status).toBe("unknown");
    for (let i = 0; i < 8; i++) {
      const p = r.disk().wall!.resumeStates!.a;
      expect(p.nextAt! - r.at()).toBeLessThanOrEqual(300_000);
      r.advance(p.nextAt! - r.at()); await r.wall.tick();
    }
    expect(r.disk().wall!.resumeStates!.a.nextAt! - r.at()).toBe(300_000);
    r.unreadable(false); r.deps.mainTurnBusy = async () => false;
    r.advance(); await createQuotaWall(r.deps).tick();
    expect(r.attempts).toEqual(["a"]);
    expect(r.disk().wall!.resumeStates!.a.status).toBe("unknown");
  });

  test("a failed progress notice retries after restart and backs off independently of delivery", async () => {
    const r = rig(); await r.hit("a");
    let notifications = 0;
    r.deps.notifyOwner = async (text) => { notifications++; r.notices.push(text); return notifications > 1; };
    r.wall.clear(); await r.wall.tick();
    const reboot = createQuotaWall(r.deps);
    r.advance(1_000); await reboot.tick(); expect(notifications).toBe(1);
    r.advance(299_000); await reboot.tick(); expect(notifications).toBe(2);
    r.advance(); await createQuotaWall(r.deps).tick(); expect(notifications).toBe(2);
    expect(r.disk().wall!.recoveredNotifiedAt).toBeUndefined();
  });

  test("a legacy held resume is rejected with an explicit diagnostic", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env: Envelope = { from: { kind: "bridge", label: "quota-wall" },
        to: { kind: "local", channelId: "legacy", agentName: "legacy-agent", ws: {} as never },
        intent: "notification", content: "continue", meta: { messageId: "old-resume-plan", triggerKind: "bridge_synth",
          ts: new Date(T0).toISOString(), threadId: "synthetic-thread" } };
      expect(quotaResumeWanted(env, () => { throw new Error("must not acquire a new binding"); })).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("旧版或无身份绑定"));
    } finally { warning.mockRestore(); }
  });
});

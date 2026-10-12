import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaService } from "../src/bridge/quota-service.js";
import { quotaResumeWanted } from "../src/bridge/quota-wall-wiring.js";
import type { Envelope } from "../src/bridge/router.js";
import { quotaResumeMessageId } from "../src/lib/quota-resume-state.js";
import { readQuotaResumeTarget } from "../src/lib/quota-resume-state-identity.js";
import { emptyWallState, exitVia, noteWallHit, type WallProbe } from "../src/lib/quota-wall.js";
import { parseClaudeUsage } from "../src/lib/quota-dto.js";
import { QuotaScheduler, type RemoteView } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";

const T0 = Date.parse("2026-10-11T06:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });

function facts() {
  const dir = mkdtempSync(join(tmpdir(), "qresume-facts-")); dirs.push(dir);
  const paths = { registry: join(dir, "registry.json"), ledger: join(dir, "ledger.sqlite") };
  const registry = (over: Record<string, unknown> = {}) => writeFileSync(paths.registry, JSON.stringify({ agents: {
    "agent-a": { channelId: "a", sessionId: "original", status: "active", kind: "worker", ...over },
  } }));
  registry();
  const db = new Database(paths.ledger);
  db.exec(`CREATE TABLE tasks(id TEXT, agent TEXT, stage TEXT, extra TEXT);
    CREATE TABLE worker_agents(agent TEXT, sessionId TEXT, taskId TEXT, role TEXT, createdBy TEXT, createdAt INTEGER, state TEXT, retiredAt INTEGER, reason TEXT);
    INSERT INTO tasks VALUES('task-1','agent-a','build','{}');
    INSERT INTO worker_agents VALUES('agent-a','original','task-1','author','pm',1,'active',NULL,NULL);`);
  const read = () => readQuotaResumeTarget("a", "agent-a", paths);
  return { paths, db, registry, read };
}

describe("[验收线 2] production target facts use synthetic ledger only", () => {
  test("session and registration generation identify the exact target; task completion cancels", () => {
    const f = facts();
    try {
      const first = f.read(); expect(first.kind).toBe("ready");
      f.db.exec("UPDATE worker_agents SET createdAt = 2");
      expect(f.read()).not.toEqual(first);
      f.db.exec("UPDATE tasks SET stage = 'done'");
      expect(f.read()).toEqual({ kind: "cancelled", reason: "task_finished" });
    } finally { f.db.close(); }
  });

  test("frozen task and malformed task metadata remain unknown", () => {
    const f = facts();
    try {
      f.db.exec(`UPDATE tasks SET extra = '{"frozen":true}'`);
      expect(f.read()).toEqual({ kind: "unknown", reason: "task_protected" });
      f.db.exec("UPDATE tasks SET extra = '{bad'");
      expect(f.read()).toEqual({ kind: "unknown", reason: "ledger_unreadable" });
    } finally { f.db.close(); }
  });

  test("corrupt registry cannot use last-good data; retired target cancels", () => {
    const f = facts();
    try {
      expect(f.read().kind).toBe("ready");
      writeFileSync(f.paths.registry, "{bad");
      expect(f.read()).toEqual({ kind: "unknown", reason: "registry_unreadable" });
      f.registry({ status: "stopped" });
      expect(f.read()).toEqual({ kind: "cancelled", reason: "target_retired_or_replaced" });
    } finally { f.db.close(); }
  });

  test("same-session new task invalidates an already-held envelope", () => {
    const f = facts();
    try {
      const t = f.read(); expect(t.kind).toBe("ready"); if (t.kind !== "ready") throw new Error("fixture");
      const env: Envelope = { from: { kind: "bridge", label: "quota-wall" }, to: { kind: "local", channelId: "a", agentName: "agent-a", ws: {} as never },
        intent: "notification", content: "continue", meta: { messageId: quotaResumeMessageId({ identity: t.identity, messageId: "plan" }),
          triggerKind: "bridge_synth", ts: "", threadId: "thread", expectSession: "original" } };
      expect(quotaResumeWanted(env, f.read)).toBe(true);
      f.db.exec("INSERT INTO tasks VALUES('task-2','agent-a','build','{}'); UPDATE worker_agents SET taskId = 'task-2', createdAt = 2");
      expect(quotaResumeWanted(JSON.parse(JSON.stringify(env)), f.read)).toBe(false);
    } finally { f.db.close(); }
  });

  test("unknown worker without a ledger is not treated as an ordinary user session", () => {
    const f = facts(); f.db.close();
    expect(readQuotaResumeTarget("a", "agent-a", { ...f.paths, ledger: join(dirs.at(-1)!, "absent.sqlite") }))
      .toEqual({ kind: "unknown", reason: "worker_ledger_missing" });
  });
});

function service(body: Record<string, unknown>, stale = false) {
  const data = parseClaudeUsage(body, () => "synthetic-credit")!;
  expect(data).not.toBeNull();
  const remote: RemoteView = {
    claude: { account: { key: "synthetic-account", identity: "bound", uncertain: false }, credFailure: null,
      endpoints: { claude_usage: { snapshot: { data, observedAt: T0 + 1 }, stale, lastCode: null, paused: false } } },
    codex: { account: null, credFailure: null, endpoints: {} },
  };
  const scheduler = new QuotaScheduler({ now: () => T0 + 2, random: () => 0.5,
    fetch: async () => { throw new Error("unexpected network"); },
    readCredential: async () => { throw new Error("unexpected credential read"); },
    peekAccountKey: async () => null, confirmCredential: async () => false, hashCreditId: () => "synthetic-credit",
    store: memoryQuotaStore(), isEnabled: () => true });
  scheduler.view = async () => remote;
  scheduler.refresh = async () => ({ status: "disabled" });
  return createQuotaService({ now: () => T0 + 2, makeScheduler: () => scheduler, readEnabled: () => true,
    writeEnabled: async () => {}, local: async () => ({ claudeCache: null, codexRollout: null, extra: [] }),
    afterTick: async () => {}, setTimer: () => 0, clearTimer: () => {} });
}

function wall(kind: "weekly" | "session") {
  return noteWallHit(emptyWallState(), { channelId: "a", agent: "agent-a", at: T0, error: "rate_limit",
    parsed: { kind, resetsAt: T0 + 86_400_000, resetsText: null } }, () => "synthetic-wall").state.wall!;
}

describe("[验收线 3] quota-service preserves independent live windows", () => {
  test("unknown wall requires both live windows; one missing or invalid never exits", async () => {
    const w = { ...wall("weekly"), kind: "unknown" as const };
    for (const body of [{ five_hour: { utilization: 10 } }, { seven_day: { utilization: 10 } }]) {
      const probe = await service(body).claudeWall(false);
      expect(exitVia(w, { now: T0 + 2, probe })).toBeNull();
    }
    for (const pct of [null, NaN, Infinity, -1]) {
      expect(exitVia(w, { now: T0 + 2, probe: { pct: 10, sessionPct: 10, weekPct: pct, observedAt: T0 + 1 } })).toBeNull();
    }
    const probe = await service({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }).claudeWall(false);
    expect(exitVia(w, { now: T0 + 2, probe })).toBe("probe");
  });
  test.each(["weekly", "session"] as const)("%s needs its own new low value", async (kind) => {
    const body = kind === "weekly" ? { five_hour: { utilization: 10 } } : { seven_day: { utilization: 10 } };
    const probe = await service(body).claudeWall(true);
    expect(probe).toMatchObject({ pct: 10, sessionPct: kind === "weekly" ? 10 : null, weekPct: kind === "weekly" ? null : 10, observedAt: T0 + 1 });
    expect(exitVia(wall(kind), { now: T0 + 2, probe })).toBeNull();
    const complete = await service({ five_hour: { utilization: kind === "session" ? 10 : 100 },
      seven_day: { utilization: kind === "weekly" ? 10 : 100 } }).claudeWall(true);
    expect(exitVia(wall(kind), { now: T0 + 2, probe: complete })).toBe("probe");
  });

  test("parse failure of the blocking window and stale live data never release the wall", async () => {
    const body = { five_hour: { utilization: 10 }, seven_day: { utilization: "invalid" } };
    const probe = await service(body).claudeWall(true);
    expect(probe!.weekPct).toBeNull();
    expect(exitVia(wall("weekly"), { now: T0 + 2, probe })).toBeNull();
    const stale = await service({ five_hour: { utilization: 10 }, seven_day: { utilization: 10 } }, true).claudeWall(true);
    expect(stale).toMatchObject({ sessionPct: null, weekPct: null, pct: null });
    expect(exitVia(wall("weekly"), { now: T0 + 2, probe: stale })).toBeNull();
  });

  test("old and invalid blocking observations do not exit; CLI and a real reset remain independent", () => {
    const w = wall("weekly");
    for (const pct of [null, NaN, Infinity, -1]) {
      const probe: WallProbe = { pct: 10, sessionPct: 10, weekPct: pct, observedAt: T0 + 1 };
      expect(exitVia(w, { now: T0 + 2, probe })).toBeNull();
    }
    expect(exitVia(w, { now: T0 + 2, probe: { pct: 10, sessionPct: 10, weekPct: 10, observedAt: T0 } })).toBeNull();
    expect(exitVia(w, { now: T0 + 2, cli: true })).toBe("cli");
    expect(exitVia(w, { now: T0 + 2, limitsReset: true })).toBe("limits_reset");
    expect(exitVia(w, { now: w.resetsAt! + 60_000 })).toBe("resets_at");
  });
});

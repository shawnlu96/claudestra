import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { readSessionHistory } from "../src/lib/session-history.js";
import type { SharedLedgerLocalCredential } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerUnavailable } from "../src/lib/shared-ledger-client-transport.js";
import { parseTeamBodyPageReturn, type TeamBodyPageClaimed, type TeamBodyPageReturn } from "../src/lib/shared-ledger-contract-team-body.js";
import type { MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import type { HistoryMessage, HistoryPage } from "../src/lib/session-history-types.js";
import { TEAM_BODY_MASK } from "../src/lib/team-body-scrub.js";
import {
  decodeCursor, encodeCursor, homeCardOf, serveSessionPage, type CardSession, type HomeCard, type SessionPageDeps, type SessionPageRequest,
} from "../src/lib/team-body-session.js";
import type { TeamBodyMode } from "../src/lib/team-body-switch.js";
import {
  claimTargetsOf, runTeamBodyFetchOnce, teamBodyBackoffMs, TeamBodyUnsupported, type ClaimTarget, type TeamBodyCenter, type TeamBodyFetchDeps,
  type TeamBodyFetchState,
} from "../src/bridge/team-body-fetch.js";

/** Assembled from pieces so no scanner reads this file as holding a key. */
const KEY = `sk-${"FAKE".repeat(6)}`;
const S1 = "aaaaaaaa-1111-2222-3333-444444444444";
const S2 = "bbbbbbbb-1111-2222-3333-444444444444";
const scope = { centerId: "center-1", teamId: "team-1", instanceId: "inst-home" };
const request = (cursor: string | null = null, limit = 50): SessionPageRequest =>
  ({ projectId: "proj-c", featureId: "feat-c", taskId: "task-1", cursor, limit });
const card: HomeCard = { localProject: "local-p", localTaskId: "task-1", sessions: [{ sessionId: S1, agent: "agent-a" }, { sessionId: S2, agent: "agent-b" }] };
const msg = (seq: number, text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ seq, ts: null, role: "assistant", text, ...extra });

function deps(o: { card?: HomeCard | null; mode?: TeamBodyMode; pages?: Record<string, HistoryPage> } = {}) {
  const reads: { session: CardSession; before: number | null }[] = [];
  const d: SessionPageDeps = {
    card: () => (o.card === undefined ? card : o.card),
    mode: () => o.mode ?? "on",
    readPage: async (session, before) => {
      reads.push({ session, before });
      return o.pages?.[`${session.sessionId}:${before ?? "tail"}`] ?? null;
    },
    scrub: { identity: { username: "fake-user", hostname: "fake-host" } },
  };
  return { d, reads };
}

describe("serveSessionPage: permission checks run before any file is read", () => {
  test("a sessionId that is not bound to the card is refused unread", async () => {
    const { d, reads } = deps();
    const forged = encodeCursor({ sessionId: "cccccccc-0000-0000-0000-000000000000", before: null });
    expect(await serveSessionPage(scope, request(forged), d)).toEqual({ kind: "refused", code: "gate_refused" });
    for (const bad of ["v1:../../etc:tail", "v1:" + S1, `v2:${S1}:tail`, `v1:${S1}:-1`, `v1:${S1}:01`]) {
      expect(await serveSessionPage(scope, request(bad), d)).toEqual({ kind: "refused", code: "gate_refused" });
    }
    expect(reads).toEqual([]);
  });

  test("a card that is not home here is refused unread", async () => {
    const { d, reads } = deps({ card: null });
    expect(await serveSessionPage(scope, request(), d)).toEqual({ kind: "refused", code: "gate_refused" });
    expect(reads).toEqual([]);
  });

  test("teamBody observe / off answer not_open unread", async () => {
    for (const mode of ["observe", "off"] as const) {
      const { d, reads } = deps({ mode });
      expect(await serveSessionPage(scope, request(), d)).toEqual({ kind: "refused", code: "not_open" });
      expect(reads).toEqual([]);
    }
  });
});

describe("serveSessionPage: the page", () => {
  test("is scrubbed; attachments, reply files and buttons never appear", async () => {
    const page: HistoryPage = { total: 2, hasMore: false, messages: [
      msg(3, "plain words stay", { role: "user", attachments: ["/tmp/inbox/secret-plan.pdf"], from: "owner" }),
      msg(7, `here is the key\n\n${KEY}\n\n(after stays)`, {
        replyText: "reply stays", replyFiles: ["report-file.txt"], replyComponents: [{ type: "buttons", buttons: [{ id: "btn-x", label: "Go" }] }],
        tools: [{ name: "Bash", summary: `curl -H "Authorization: Bearer ${KEY}"`, detail: "detail-not-sent" }],
      }),
    ] };
    const { d, reads } = deps({ pages: { [`${S1}:tail`]: page } });
    const result = await serveSessionPage(scope, request(), d);
    if (result.kind !== "page") throw new Error("expected a page");
    expect(reads).toEqual([{ session: card.sessions[0]!, before: null }]);
    expect(result.records.map((r) => r.sourceKey)).toEqual([`${S1}:3`, `${S1}:7`]);
    const all = result.records.map((r) => r.text).join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("FAKE");
    for (const absent of ["secret-plan.pdf", "report-file.txt", "btn-x", "detail-not-sent", "owner"]) expect(all).not.toContain(absent);
    expect(all).toContain("plain words stay");
    expect(all).toContain("after stays");
    expect(all).toContain("reply stays");
    expect(result.records[1]!.text).toContain(TEAM_BODY_MASK);
    expect(result.records[1]!.maskedSegments).toBeGreaterThanOrEqual(2);
    expect(result.records[0]!.maskedSegments).toBe(0);
    // Passes the contract's own checks (digest, kinds, sizes).
    expect(() => parseTeamBodyPageReturn({ schemaVersion: 1, requestId: "req-1", sourceInstanceId: "inst-home", result })).not.toThrow();
    // Session 1 read to its start: the cursor goes on to the next bound session.
    expect(result.nextCursor).toBe(encodeCursor({ sessionId: S2, before: null }));
  });

  test("pages back within a session, then ends", async () => {
    const { d } = deps({ pages: {
      [`${S2}:tail`]: { total: 3, hasMore: true, messages: [msg(10, "ten"), msg(12, "twelve")] },
      [`${S2}:10`]: { total: 3, hasMore: false, messages: [msg(4, "four")] },
    } });
    const first = await serveSessionPage(scope, request(encodeCursor({ sessionId: S2, before: null })), d);
    expect(first).toMatchObject({ kind: "page", nextCursor: `v1:${S2}:10` });
    const second = await serveSessionPage(scope, request(`v1:${S2}:10`), d);
    expect(second).toMatchObject({ kind: "page", nextCursor: null });
    expect(decodeCursor(`v1:${S2}:10`)).toEqual({ sessionId: S2, before: 10 });
  });

  test("a cursor at a check_inbox message (fractional seq) reads back", async () => {
    expect(decodeCursor(`v1:${S1}:2.01`)).toEqual({ sessionId: S1, before: 2.01 });
    expect(decodeCursor(encodeCursor({ sessionId: S1, before: 2.1 }))).toEqual({ sessionId: S1, before: 2.1 });
    for (const bad of [`v1:${S1}:2.`, `v1:${S1}:2.001`, `v1:${S1}:.5`, `v1:${S1}:1e3`]) expect(decodeCursor(bad)).toBeNull();
  });

  test("pages across a check_inbox message with the real history reader", async () => {
    const me = { tag: "ws" } as never;
    const to = { kind: "local", agentName: "agent-a", channelId: "c-me", ws: me } as LocalEndpoint;
    const item = (content: string, id: string): HeldItem => ({ to, heldAt: 0, env: { to, intent: "request", content,
      from: { kind: "local", agentName: "scheduler", channelId: "c-s", ws: me },
      meta: { messageId: id, triggerKind: "agent_tool", ts: "2026-10-03T00:00:00Z", threadId: `thr-${id}` } } as Envelope });
    const held = new HeldQueue(null);
    held.set("c-me", [item("inbox one", "agent_n1"), item("inbox two", "agent_n2")]);
    initInbox({ clients: new Map([["c-me", { ws: me }]]), held, calls: new AgentCallBook(null), render: async (e) => e.content,
      emitIn: () => {}, stoppedAt: () => undefined });
    const taken = await takeInbox(me, 60_000, {});
    if ("error" in taken) throw new Error(taken.error);
    const ts = (s: number) => new Date(Date.parse("2026-10-03T01:00:00Z") + s * 1000).toISOString();
    const path = join(mkdtempSync(join(tmpdir(), "tbs-")), "s.jsonl");
    writeFileSync(path, [
      { type: "assistant", timestamp: ts(0), message: { content: [{ type: "text", text: "first words" }] } },
      { type: "assistant", timestamp: ts(1), message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__claudestra__check_inbox", input: {} }] } },
      { type: "user", timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: taken.result.text }] }] } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const d: SessionPageDeps = { ...deps().d, readPage: (_, before, limit) => readSessionHistory(path, { limit, ...(before === null ? {} : { before }) }) };
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const r = await serveSessionPage(scope, request(cursor, 1), d);
      if (r.kind !== "page") throw new Error(`refused at ${cursor}`);
      parseTeamBodyPageReturn({ schemaVersion: 1, requestId: "r", sourceInstanceId: "inst-home", result: r });
      seen.unshift(...r.records.map((x) => x.text));
      cursor = r.nextCursor;
    } while (cursor && cursor.startsWith(`v1:${S1}:`) && ++pages < 10);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen.some((t) => t.includes("inbox one"))).toBe(true);
    expect(seen.some((t) => t.includes("inbox two"))).toBe(true);
    expect(seen[0]).toContain("first words");
  });

  test("a card with no bound session answers an empty last page", async () => {
    const { d, reads } = deps({ card: { ...card, sessions: [] } });
    expect(await serveSessionPage(scope, request(), d)).toEqual({ kind: "page", records: [], nextCursor: null });
    expect(reads).toEqual([]);
  });
});

describe("homeCardOf", () => {
  const entry: MirrorEntry = {
    enabled: true, batchId: "b", centerId: "center-1", teamId: "team-1", projectId: "proj-c", centerFeatureId: "feat-c",
    sourceInstanceId: "inst-home", localProject: "local-p", watermark: 0, snapshot: false, fingerprints: {}, taskMeta: {},
    lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0,
  };
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT, featureId TEXT)");
  db.run("CREATE TABLE scheduler_sessions (taskId TEXT, role TEXT, agent TEXT, sessionId TEXT)");
  db.run("INSERT INTO tasks VALUES ('task-1', 'local-p', 'local-feat'), ('task-2', 'other-p', 'local-feat'), ('task-3', 'local-p', 'other-feat')");
  db.run(`INSERT INTO scheduler_sessions VALUES ('task-1', 'reviewer', 'agent-r', '${S2}'), ('task-1', 'author', 'agent-a', '${S1}'),
    ('task-3', 'author', 'agent-z', 'dddddddd-0000-0000-0000-000000000000')`);
  const mirrors = { "local-feat": entry };
  const mine = () => "inst-home";

  test("lists the sessions the scheduler bound to the task, author first", () => {
    expect(homeCardOf(scope, request(), mirrors, mine, db)).toEqual({ localProject: "local-p", localTaskId: "task-1",
      sessions: [{ agent: "agent-a", sessionId: S1 }, { agent: "agent-r", sessionId: S2 }] });
  });

  test("refuses another instance, another feature's task, a disabled mirror, an unknown task", () => {
    expect(homeCardOf(scope, request(), mirrors, () => "inst-other", db)).toBeNull();
    expect(homeCardOf({ ...scope, instanceId: "inst-other" }, request(), mirrors, () => "inst-other", db)).toBeNull();
    expect(homeCardOf(scope, request(), { "local-feat": { ...entry, enabled: false } }, mine, db)).toBeNull();
    expect(homeCardOf(scope, { ...request(), featureId: "feat-x" }, mirrors, mine, db)).toBeNull();
    for (const taskId of ["task-2", "task-3", "task-9"]) expect(homeCardOf(scope, { ...request(), taskId }, mirrors, mine, db)).toBeNull();
  });
});

describe("runTeamBodyFetchOnce", () => {
  const claimed = (requests: TeamBodyPageClaimed["requests"] = []): TeamBodyPageClaimed => ({ schemaVersion: 1, requests });
  function rig(center: Partial<TeamBodyCenter>, targets = true) {
    let now = 1_000_000;
    const calls = { capability: 0, claim: 0, sent: [] as TeamBodyPageReturn[] };
    const logs: string[] = [];
    const target: ClaimTarget = { key: "k", scope, secrets: [], center: {
      capability: async () => { calls.capability++; return center.capability ? center.capability() : true; },
      claim: async (waitMs) => { calls.claim++; now += waitMs; return center.claim ? center.claim(waitMs) : claimed(); },
      send: async (ret) => { calls.sent.push(ret); if (center.send) await center.send(ret); },
    } };
    const d: TeamBodyFetchDeps = {
      now: () => now, targets: () => (targets ? [target] : []), log: (l) => logs.push(l),
      serve: (t, r) => serveSessionPage(t.scope, r, deps({ mode: "observe" }).d),
    };
    return { d, calls, logs, advance: (ms: number) => { now += ms; }, now: () => now };
  }

  test("nothing to claim for (teamBody off everywhere): no center call", async () => {
    const { d, calls } = rig({}, false);
    const state: TeamBodyFetchState = new Map();
    for (let i = 0; i < 3; i++) await runTeamBodyFetchOnce(state, d);
    expect(calls).toEqual({ capability: 0, claim: 0, sent: [] });
  });

  test("a center without the extension is not polled", async () => {
    const { d, calls } = rig({ capability: async () => false });
    const state: TeamBodyFetchState = new Map();
    for (let i = 0; i < 3; i++) await runTeamBodyFetchOnce(state, d);
    expect(calls.capability).toBe(1);
    expect(calls.claim).toBe(0);
    const late = rig({ claim: async () => { throw new TeamBodyUnsupported(); } });
    const s2: TeamBodyFetchState = new Map();
    await runTeamBodyFetchOnce(s2, late.d);
    await runTeamBodyFetchOnce(s2, late.d);
    expect(late.calls.claim).toBe(1);
  });

  test("observe answers each claimed request not_open; expired ones are dropped", async () => {
    const { d, calls, now } = rig({ claim: async () => claimed([
      { requestId: "req-1", expiresAt: now() + 60_000, ...request() },
      { requestId: "req-old", expiresAt: 1, ...request() },
    ]) });
    expect(await runTeamBodyFetchOnce(new Map(), d)).toBe(0);
    expect(calls.sent).toEqual([{ schemaVersion: 1, requestId: "req-1", sourceInstanceId: "inst-home", result: { kind: "refused", code: "not_open" } }]);
  });

  test("an idle claim keeps the 8 s minimum interval", async () => {
    const { d } = rig({ claim: async () => claimed() });
    // The fake claim spends its whole 8 s wait.
    expect(await runTeamBodyFetchOnce(new Map(), d)).toBe(0);
    const quick = rig({});
    const q = { ...quick.d, targets: () => [{ ...(quick.d.targets()[0]!), center: { ...quick.d.targets()[0]!.center, claim: async () => claimed() } }] };
    expect(await runTeamBodyFetchOnce(new Map(), q)).toBe(8_000);
  });

  test("an unreachable center backs off, bounded, with one log line per spell", async () => {
    let down = true;
    const { d, calls, logs, advance } = rig({ claim: async () => { if (down) throw new SharedLedgerUnavailable(); return claimed(); } });
    const state: TeamBodyFetchState = new Map();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const delay = await runTeamBodyFetchOnce(state, d);
      delays.push(delay);
      advance(delay);
    }
    expect(calls.claim).toBe(12);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5 * 60_000);
    expect(delays.slice(-3)).toEqual([5 * 60_000, 5 * 60_000, 5 * 60_000]);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("center-1");
    down = false;
    await runTeamBodyFetchOnce(state, d);
    expect(logs).toHaveLength(2);
    expect(state.get("k")!.failures).toBe(0);
    expect(teamBodyBackoffMs(1)).toBe(8_000);
    expect(teamBodyBackoffMs(50)).toBe(5 * 60_000);
  });
  test("an unreachable return backs off too: one send per spell step, one log line, a later claim does not reset it", async () => {
    let down = true;
    const { d, calls, logs, advance, now } = rig({
      claim: async () => claimed([1, 2, 3].map((i) => ({ requestId: `req-${i}`, expiresAt: now() + 3_600_000, ...request() }))),
      send: async () => { if (down) throw new SharedLedgerUnavailable(); },
    });
    const state: TeamBodyFetchState = new Map();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const delay = await runTeamBodyFetchOnce(state, d);
      delays.push(delay);
      advance(delay);
    }
    expect(calls.claim).toBe(12);
    expect(calls.sent).toHaveLength(12); // the first of each batch only
    expect(delays.every((x) => x > 0)).toBe(true);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(delays.slice(-3)).toEqual([5 * 60_000, 5 * 60_000, 5 * 60_000]);
    expect(state.get("k")!.failures).toBe(12);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("回传");
    down = false;
    expect(await runTeamBodyFetchOnce(state, d)).toBe(0);
    expect(calls.sent).toHaveLength(15);
    expect(logs).toHaveLength(2);
    expect(state.get("k")!.failures).toBe(0);
  });
});

describe("claimTargetsOf: only teamBody on polls", () => {
  const entry = (localProject: string, enabled = true) => ({
    enabled, batchId: "b", centerId: "center-1", teamId: `team-${localProject}`, projectId: "proj-c", centerFeatureId: "feat-c",
    sourceInstanceId: "inst-home", localProject, watermark: 0, snapshot: false, fingerprints: {}, taskMeta: {},
    lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0,
  }) as MirrorEntry;
  const credential = { instanceId: "inst-home", bearer: "bearer-x", teamId: "t" } as SharedLedgerLocalCredential;
  const modes: Record<string, TeamBodyMode> = { p_on: "on", p_obs: "observe", p_off: "off", p_dis: "on" };
  const mirrors = { a: entry("p_on"), b: entry("p_obs"), c: entry("p_off"), d: entry("p_dis", false) };
  const center = {} as TeamBodyCenter;

  test("observe, off and disabled mirrors add no target; on adds one", () => {
    let keys = 0;
    const targets = claimTargetsOf(mirrors, { mode: (p) => modes[p]!, credential: () => credential, key: () => (keys++, {} as never), center: () => center });
    expect(targets.map((t) => t.scope.teamId)).toEqual(["team-p_on"]);
    expect(targets[0]!.secrets).toEqual(["bearer-x"]);
    expect(keys).toBe(1);
  });

  test("nothing on: no key read, no target", () => {
    let keys = 0;
    expect(claimTargetsOf(mirrors, { mode: (p) => (p === "p_off" ? "off" : "observe"), credential: () => credential,
      key: () => (keys++, {} as never), center: () => center })).toEqual([]);
    expect(keys).toBe(0);
  });
});

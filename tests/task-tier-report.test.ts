import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { bindLaunchSession, recordLaunchAttempt, recordLaunchFailed, type LaunchPlan } from "../src/lib/task-tier-launch-events.js";
import { taskTierReport } from "../src/lib/task-tier-report.js";
import { openUsageDb, usageWriter } from "../src/lib/usage-store.js";
import { TASK_TIER_REPORT_CMD, readTierSessionUsage } from "../src/manager/ledger-task-tier-report-cmd.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { READER_ONLY_SUBS, isWriteInvocation } from "../src/manager/write-commands.js";

const DAY = 86_400_000, end = Date.UTC(2026, 9, 17), start = end - 7 * DAY;
const clean: (() => void)[] = [];
afterEach(() => { for (const f of clean.splice(0)) f(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tier-report-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const usage = openUsageDb(join(dir, "usage", "usage.sqlite"));
  clean.push(() => { usage.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const card = (id: string) => createTask(db, { actor: "owner", now: start - DAY }, { id, project: "p", title: id, kind: "code" });
  const event = (id: string, kind: string, data: object, ts: number) => db.query(
    "INSERT INTO events(ts, actor, project, target, kind, text, data) VALUES (?, 'fixture', 'p', ?, ?, '', ?)").run(ts, id, kind, JSON.stringify(data));
  const launch = (card: string, id: string, session: string | null, ts = start + DAY, role = "author", tier = "ui", actual = true) => {
    const plan: LaunchPlan = { project: "p", card, role, tier, family: "codex", round: 42, launchId: id, agent: id,
      suggested: "high", final: { model: null, effort: "high" }, source: "tier-default" };
    recordLaunchAttempt(db, plan, ts);
    if (session) bindLaunchSession(db, { project: "p", card, role, agent: id, sessionId: session,
      ...(actual ? { actual: { model: "fixture-model", effort: "medium", source: "suggest" as const } } : {}) }, ts + 1);
    return plan;
  };
  const call = (session: string, key: string, ts: number) => {
    const writer = usageWriter(usage), turn = `turn-${session}`;
    writer.turn({ turnId: turn, agent: "fixture", sessionId: session, sidechain: false, startedAt: ts, kind: "user", trigger: "", runtime: "codex" });
    writer.call({ key, ts, model: "fixture-model", input: 10, output: 5, cacheCreation: 2, cacheRead: 3, reasoning: 1, tools: [] }, turn);
  };
  const report = () => taskTierReport(db, "p", { now: end, mode: "off", readUsage: (id, a, b) => readTierSessionUsage(usage, id, a, b) });
  return { dir, db, usage, path, card, event, launch, call, report };
}

test("[验收线 1] seven-day bounds, card denominators, last review, cross-window rework and unknown", () => {
  const s = setup();
  for (const id of ["A", "B", "C", "outside"]) s.card(id);
  s.launch("A", "a", "sa", start);
  s.launch("B", "b", "sb", start + 1, "author", "ui", false);
  s.event("A", "review", { verdict: "changes", round: 40 }, start - 1);
  s.event("A", "review", { verdict: "changes", round: 41 }, start + 2);
  s.event("A", "review", { verdict: "pass", round: 42 }, end - 1);
  s.event("A", "stage", { from: "review", to: "fix" }, start - 1);
  s.event("A", "stage", { from: "review", to: "fix" }, start);
  s.event("A", "stage", { from: "blocked", to: "fix" }, start + 3);
  s.event("A", "review", { verdict: "block" }, end);
  s.event("C", "note", {}, start);
  s.event("outside", "note", {}, start - 1);
  s.event("outside", "note", {}, end);
  s.call("sa", "old", start - 1); s.call("sa", "first", start); s.call("sa", "last", end - 1); s.call("sa", "future", end);
  s.call("sa", "last", end - 1); // Stored call-key replay must not increase the total.
  const r = s.report();
  expect(r.currentMode).toBe("off"); expect(r.cards).toBe(3); expect(r.window).toMatchObject({ start, end, days: 7 });
  expect(r.rows.find(r => r.model === "fixture-model")).toMatchObject({ cards: ["A"], cardCount: 1, reviewedCards: 1, passedCards: 1, passRate: 1, reworkRounds: 1, launches: 1 });
  expect(r.rows.find(r => r.role === "unknown")).toMatchObject({ tier: "unknown", cards: ["C"], passRate: null });
  expect(r.rows.find(r => r.role === "author" && r.model === "unknown")).toMatchObject({ effort: "unknown", missingUsageSessions: 1, usage: null });
  expect(r.totalUsage).toEqual({ calls: 2, input: 20, output: 10, cacheCreation: 4, cacheRead: 6, reasoning: 2 });
});

test("[验收线 1] shared sessions counted once across cards and roles; failed launches and missing usage separate", () => {
  const s = setup(); for (const id of ["A", "B", "F"]) s.card(id);
  s.launch("A", "a", "shared"); s.launch("B", "b", "shared"); s.launch("B", "r", "shared", start + 2, "reviewer", "code");
  const failed = s.launch("F", "fail", null); recordLaunchFailed(s.db, failed, "fixture failure", start + 2 * DAY);
  expect(recordLaunchAttempt(s.db, failed, start + 3 * DAY)).toBe(false);
  s.call("shared", "one", start + 2 * DAY);
  s.event("A", "review", { verdict: "pass", round: 42 }, start + 2 * DAY);
  s.event("B", "review", { verdict: "changes", round: 42 }, start + 2 * DAY);
  const r = s.report();
  expect(r.rows.find(r => r.role === "author" && r.model === "fixture-model")).toMatchObject({ cardCount: 2, reviewedCards: 2, passedCards: 1, passRate: 0.5 });
  expect(r.cards).toBe(3); expect(r.totalUsage?.calls).toBe(1); expect(r.usageSessions).toBe(1);
  expect(r.sharedSessions).toHaveLength(1); expect(r.sharedSessions[0].groups).toHaveLength(2);
  expect(r.rows.filter(r => r.model === "fixture-model").every(r => r.usage === null)).toBe(true);
  expect(r.rows.find(r => r.cards.includes("F"))).toMatchObject({ failedLaunches: 1, unboundLaunches: 1, missingUsageSessions: 0 });
});

test("[验收线 1] session launched before window supplies window usage but no new launch or old review", () => {
  const s = setup(); s.card("old"); s.launch("old", "old-launch", "old-session", start - DAY);
  s.call("old-session", "now", start + 1); s.event("old", "review", { verdict: "pass" }, start - 1);
  expect(s.report().rows[0]).toMatchObject({ cards: ["old"], launches: 0, reviewedCards: 0, passRate: null, usage: { calls: 1 } });
});

test("[验收线 1/4] read-only report leaves database bytes, schema, events and usage unchanged; no writer command classification", () => {
  const s = setup(); s.card("A"); s.launch("A", "a", "s"); s.call("s", "one", start + 1);
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); s.usage.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = readFileSync(s.path), usageBefore = readFileSync(s.usage.filename);
  const dump = JSON.stringify(s.db.query("SELECT * FROM events").all());
  const schema = JSON.stringify(s.db.query("SELECT * FROM sqlite_master ORDER BY name").all());
  s.db.exec("PRAGMA query_only=ON"); s.usage.exec("PRAGMA query_only=ON");
  expect(s.report().totalUsage?.calls).toBe(1);
  expect(readFileSync(s.path)).toEqual(before); expect(readFileSync(s.usage.filename)).toEqual(usageBefore);
  expect(JSON.stringify(s.db.query("SELECT * FROM events").all())).toBe(dump);
  expect(JSON.stringify(s.db.query("SELECT * FROM sqlite_master ORDER BY name").all())).toBe(schema);
  expect(READER_ONLY_SUBS.has("task-tier-report")).toBe(true); expect(isWriteInvocation("ledger", ["task-tier-report", "p", "--days", "7"])).toBe(false);
  expect(() => taskTierReport(s.db, "p", { days: 0 })).toThrow("days");
});


test("[验收线 1] future binding cannot backfill past actual values; zero usage is absent, not fabricated", () => {
  const s = setup(); s.card("A");
  s.launch("A", "future-bound", "session", end - 1); // binding at end belongs to the next window
  expect(s.report().rows[0]).toMatchObject({ model: "unknown", effort: "unknown", pendingLaunches: 1, unboundLaunches: 1 });
  expect(s.report().totalUsage).toBeNull();
});


test("[验收线 1/4] CLI accepts a positional project and validates days without creating or migrating a database", async () => {
  const s = setup(); s.card("A"); s.event("A", "note", {}, start + 1);
  s.db.exec("PRAGMA query_only=ON");
  const run = (args: string[]) => {
    const p = parseLedgerArgs(["task-tier-report", ...args], TASK_TIER_REPORT_CMD.valued, TASK_TIER_REPORT_CMD.bools);
    if ("error" in p) throw new Error(p.error);
    const c = new LedgerCli({ db: s.db, actor: "unknown", projectIds: ["p"], now: () => end,
      loadRegistry: async () => { throw new Error("must not read registry"); }, saveRegistry: async () => { throw new Error("must not write registry"); } }, p);
    return TASK_TIER_REPORT_CMD.run(c);
  };
  expect(await run(["p", "--days", "7"])).toMatchObject({ ok: true, cards: 1, window: { days: 7 } });
  expect(() => run(["other"])).toThrow("没有项目");
  for (const days of ["0", "366", "1.5", "NaN", "9007199254740993"]) expect(() => run(["p", "--days", days])).toThrow("--days");
});


test("[验收线 1/4] real CLI uses existing read-only ledger even when schema version is old", async () => {
  const s = setup(); s.card("A"); s.event("A", "note", {}, Date.now() - 1000);
  s.call("old-session", "old-call", Date.now() - 1000);
  s.usage.query("UPDATE turns SET attr_task = ? WHERE session_id = ?").run("A", "old-session");
  writeFileSync(join(s.dir, "registry.json"), JSON.stringify({ agents: {} }));
  writeFileSync(join(s.dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "fixture", dirs: [s.dir] }] }));
  writeFileSync(join(s.dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { taskTierModels: "off" } } } }));
  s.db.exec("PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE)"); s.usage.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = readFileSync(s.path), usageBefore = readFileSync(s.usage.filename);
  const p = Bun.spawn([process.execPath, "--no-env-file", "src/manager.ts", "ledger", "task-tier-report", "p", "--days", "7"], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env,
      CLAUDESTRA_STATE_DIR: s.dir, FLOKA_STATE_DIR: s.dir, DISCORD_CHANNEL_ID: "" },
  });
  const stdout = await new Response(p.stdout).text(), stderr = await new Response(p.stderr).text();
  expect({ code: await p.exited, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, project: "p", currentMode: "off", cards: 1, window: { days: 7 }, totalUsage: { calls: 1 } });
  expect(readFileSync(s.path)).toEqual(before); expect(readFileSync(s.usage.filename)).toEqual(usageBefore);
  expect(s.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
}, 20_000);


test("[验收线 1] existing historical session attribution supplies usage while absent tier and actual remain unknown", () => {
  const s = setup(); for (const id of ["old-a", "old-b"]) s.card(id);
  s.call("shared-old", "usage", start + DAY);
  const r = taskTierReport(s.db, "p", { now: end, mode: "off", sessionsForCard: () => ["shared-old"],
    readUsage: (id, a, b) => readTierSessionUsage(s.usage, id, a, b) });
  expect(r.cards).toBe(2); expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({ tier: "unknown", role: "unknown", model: "unknown", effort: "unknown", cardCount: 2, launches: 0, usage: { calls: 1 } });
  expect(r.totalUsage?.calls).toBe(1); expect(r.usageSessions).toBe(1);
});

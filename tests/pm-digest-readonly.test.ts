/** agents-PMDIG2: `ledger pm-digest` is a read-only command — unknown callers can read it, and it never goes through openLedger. */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { closeLedger, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";
import { testChildEnv } from "./test-env.js";

const UNKNOWN_CHANNEL = "999000999";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A state dir with projects.json and a pm-digest.json: project p has 1 immediate + 2 mergeable in the last 24h and 1 queued. */
function stateDir(ledger = true) {
  const dir = mkdtempSync(join(tmpdir(), "pmdig2-")), path = join(dir, "ledger.sqlite"), at = Date.now() - 60_000;
  dirs.push(dir);
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-10-02T00:00:00Z" }] }));
  const rec = (project: string, send: "now" | "digest", source: string, when = at) => ({ at: when, project, send, reason: "fixture", source, mode: "observe" });
  const entry = (id: string, project: string) => ({ id, project, kind: "sync", source: "agent-w", firstLine: "进度", at });
  writeFileSync(join(dir, "pm-digest.json"), JSON.stringify({
    queue: [entry("m1", "p"), entry("m2", "other")],
    log: [rec("p", "now", "user"), rec("p", "digest", "scheduler"), rec("p", "digest", "agent-w"),
      rec("other", "now", "user"), rec("p", "digest", "scheduler", at - 25 * 3600_000)],
  }));
  if (ledger) {
    const db = openLedger(path);
    createTask(db, { actor: "owner", now: 1_000_000 }, { project: "p", id: "A", title: "卡 A", kind: "code", agent: "agent-A" });
    closeLedger(path);
  }
  return { dir, path };
}

async function run(dir: string, args: string[], channel?: string) {
  const env = testChildEnv({ CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), DISCORD_CHANNEL_ID: channel });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "ledger", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "");
}

test("[验收线 1] pm-digest is registered in both read tables; pm-digest-mode still writes", () => {
  expect(isWriteInvocation("ledger", ["pm-digest", "--project", "p"])).toBe(false);
  expect(READER_ONLY_SUBS.has("pm-digest")).toBe(true);
  expect(isWriteInvocation("ledger", ["pm-digest-mode", "on", "--project", "p"])).toBe(true);
  expect(READER_ONLY_SUBS.has("pm-digest-mode")).toBe(false);
});

test("[验收线 2] an unknown caller reads the stats through the real entry", async () => {
  const f = stateDir();
  const r = await run(f.dir, ["pm-digest", "--project", "p"], UNKNOWN_CHANNEL);
  expect(r).toMatchObject({ ok: true, project: "p", mode: "observe", now: 1, digest: 2, queued: 1,
    bySource: { now: { user: 1 }, digest: { scheduler: 1, "agent-w": 1 } } });
}, 30_000);

test("[验收线 3] a recognized caller does not write the ledger: drift, events and schema version stay as they were", async () => {
  const f = stateDir();
  const seed = new Database(f.path);
  // Drift openLedger would reconcile (assignee follows agent), and a schema version it would migrate up.
  seed.query("UPDATE tasks SET assignee = 'agent-stale' WHERE id = 'A'").run();
  seed.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - 1}`);
  const events = (seed.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  seed.close();
  expect(await run(f.dir, ["pm-digest", "--project", "p"])).toMatchObject({ ok: true, project: "p", now: 1, digest: 2, queued: 1 });
  const check = new Database(f.path, { readonly: true });
  try {
    expect(check.query("SELECT assignee FROM tasks WHERE id = 'A'").get()).toEqual({ assignee: "agent-stale" });
    expect(check.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: events });
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION - 1 });
  } finally { check.close(); }
}, 30_000);

test("[验收线 3] without a ledger db a recognized caller gets ok:false and no db is created", async () => {
  const f = stateDir(false);
  expect((await run(f.dir, ["pm-digest", "--project", "p"])).ok).toBe(false);
  expect(existsSync(f.path)).toBe(false);
}, 30_000);

test("[验收线 4] an unknown caller still cannot switch the mode", async () => {
  const f = stateDir(), modePath = join(f.dir, "pm-digest-mode.json"), before = JSON.stringify({ projects: { p: "observe" } });
  writeFileSync(modePath, before);
  expect((await run(f.dir, ["pm-digest-mode", "on", "--project", "p"], UNKNOWN_CHANNEL)).ok).toBe(false);
  expect(readFileSync(modePath, "utf8")).toBe(before);
}, 30_000);

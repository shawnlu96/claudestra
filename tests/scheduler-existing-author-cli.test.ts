/**
 * LOCAL1, real child process with its own state dir: an owner-created author whose registry identity matches the card is
 * reconciled without the creation gate or any create; unproven rows keep the full new-session gate; conflicts stay unknown.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";

const root = new URL("../", import.meta.url).pathname;
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local1-existing-")), state = join(dir, "state"), repo = join(dir, "wt");
  mkdirSync(state); mkdirSync(repo);
  run(["git", "init", "-q", "-b", "lend/t1"], repo);
  run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], repo);
  const ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  let now = 1000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  createTask(db, at("owner"), { project: "p", id: "T1", title: "local", kind: "code", agent: "agent-task-one", branch: "lend/t1",
    extra: { fileGlobs: ["src/x.ts"], localAuthorOnly: true } });
  setWorkflow(db, at("owner"), { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  // The project's only Claude seat is held by another card's bound author: any new Claude session must wait.
  createTask(db, at("owner"), { project: "p", id: "T9", title: "busy", kind: "code", agent: "agent-busy" });
  db.run("PRAGMA foreign_keys=OFF");
  db.query("UPDATE tasks SET stage='build' WHERE id='T9'").run();
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T9', 'author', 'agent-busy', 's-busy', 'claude', 'tmux', 'active', 'i9', 0, 0)`).run();
  closeLedger(ledgerPath);
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { repoDir: repo, requiredChecks: ["check"], agents: { claude: 1, codex: 1 } } } }));
  const registryPath = join(state, "registry.json");
  const author = { runtime: "claude-code", sessionId: "s-one", cwd: repo, projectId: "p", task: "T1", status: "active" };
  const registry = (over: Record<string, unknown> = {}) => writeFileSync(registryPath, JSON.stringify({ agents: { "agent-task-one": { ...author, ...over } } }));
  const ensure = async () => {
    const script = `import { openLedger, getTask } from ${JSON.stringify(root + "src/lib/ledger-store.ts")};
      import { autoTickDeps } from ${JSON.stringify(root + "src/lib/scheduler-auto-deps.ts")};
      const db = openLedger(${JSON.stringify(ledgerPath)});
      let creates = 0;
      const deps = autoTickDeps(db, { registryPath: ${JSON.stringify(registryPath)}, create: async () => { creates++; return { ok: false, error: "no" }; } });
      const first = await deps.ensure(getTask(db, "T1"), "author", "claude");
      const again = await deps.ensure(getTask(db, "T1"), "author", "claude");
      console.log(JSON.stringify({ first, again, creates }));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: state },
      stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!) as { first: Record<string, unknown>; again: Record<string, unknown>; creates: number };
  };
  return { dir, repo, registry, ensure, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("verified owner-created author is reconciled with the seat full: no gate, no create, same session every time", async () => {
  const f = fixture();
  try {
    f.registry();
    const r = await f.ensure();
    expect(r.first).toMatchObject({ kind: "ready", created: false, ref: { agent: "agent-task-one", sessionId: "s-one", family: "claude" } });
    expect(r.again).toEqual(r.first);
    expect(r.creates).toBe(0);
  } finally { f.close(); }
}, 30000);

test("a row without identity facts proves nothing: the full new-session slot gate still refuses", async () => {
  const f = fixture();
  try {
    f.registry({ projectId: undefined });
    const r = await f.ensure();
    expect(r.first).toMatchObject({ kind: "wait", reason: expect.stringContaining("等 claude 空位") });
    expect(r.creates).toBe(0);
  } finally { f.close(); }
}, 30000);

test("identity conflicts, unreadable checkouts and wrong family stay unknown / manual: no guessed binding, no new session", async () => {
  const f = fixture();
  try {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ projectId: "other" }, "unknown", "属于项目 other"],
      [{ task: "T2 别的卡" }, "unknown", "不是 T1"],
      [{ cwd: join(f.dir, "missing") }, "unknown", "读不出"],
      [{ runtime: "codex" }, "manual", "不是要求的 claude 家族"],
    ];
    for (const [over, kind, reason] of cases) {
      f.registry(over);
      const r = await f.ensure();
      expect(r.first).toMatchObject({ kind, reason: expect.stringContaining(reason) });
      expect(r.creates).toBe(0);
    }
    run(["git", "switch", "-q", "-c", "other"], f.repo);
    f.registry();
    expect((await f.ensure()).first).toMatchObject({ kind: "unknown", reason: expect.stringContaining("不是本卡 lend/t1") });
  } finally { f.close(); }
}, 60000);

test("new sessions still meet the weekly quota line (Claude 85% at runtime); a known refusal is a wait, never a retry", async () => {
  const over = { status: "known" as const, source: null, observedAt: 1, plan: null, reason: null,
    windows: [{ kind: "weekly", usedPct: 86, resetPassed: false, resetsAtMs: null }] } as never;
  let reads = 0;
  expect(await poolQuotaWait("claude", async () => { reads++; return over; })).toMatchObject({ kind: "wait", reason: expect.stringContaining("85%") });
  expect(reads).toBe(1);
});

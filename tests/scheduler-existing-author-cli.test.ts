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
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";

const root = new URL("../", import.meta.url).pathname;
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local1-existing-")), state = join(dir, "state"), repo = join(dir, "wt");
  const home = join(dir, "home"), runtime = join(dir, "runtime"), tmp = join(dir, "tmp");
  for (const d of [state, repo, home, runtime, tmp]) mkdirSync(d);
  run(["git", "init", "-q", "-b", "lend/t1"], repo);
  run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], repo);
  const ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  let now = 1000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  createTask(db, at("owner"), { project: "p", id: "T1", title: "local", kind: "code", agent: "agent-task-one", branch: "lend/t1",
    extra: { fileGlobs: ["src/x.ts"], localAuthorOnly: true } });
  setWorkflow(db, at("owner"), { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  // A real owner-written ticket holds the only seat; no scheduler history is fabricated for the competing card.
  createTask(db, at("owner"), { project: "p", id: "T9", title: "busy", kind: "code", agent: "agent-busy" });
  setWorkflow(db, at("owner"), { taskId: "T9", taskRev: 1, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "report" });
  assignStep(db, at("owner"), { taskId: "T9", step: "write", executor: "agent-busy", executorKind: "agent" });
  closeLedger(ledgerPath);
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { repoDir: repo, requiredChecks: ["check"], agents: { claude: 1, codex: 1 } } } }));
  const registryPath = join(state, "registry.json");
  const author = { runtime: "claude-code", sessionId: "s-one", cwd: repo, projectId: "p", task: "T1", status: "active" };
  const registry = (over: Record<string, unknown> = {}) => writeFileSync(registryPath, JSON.stringify({ agents: { "agent-task-one": { ...author, ...over } } }));
  const ensure = async (corruptAfterFirst = false, tickTotal?: number) => {
    const script = `import { openLedger, getTask } from ${JSON.stringify(root + "src/lib/ledger-store.ts")};
      import { autoTickDeps } from ${JSON.stringify(root + "src/lib/scheduler-auto-deps.ts")};
      const db = openLedger(${JSON.stringify(ledgerPath)});
      let creates = 0;
      const deps = autoTickDeps(db, { registryPath: ${JSON.stringify(registryPath)}, create: async () => { creates++; return { ok: false, error: "no" }; } });
      import { schedulerAutoTick } from ${JSON.stringify(root + "src/lib/scheduler-auto-tick.ts")};
      import { runLedger } from ${JSON.stringify(root + "src/manager/ledger.ts")};
      import { readFileSync } from "node:fs";
      if (${tickTotal !== undefined}) {
        const cliDeps = { db, actor: "scheduler", registryPath: ${JSON.stringify(registryPath)}, projectIds: ["p"],
          now: () => 2000, autoProjects: () => ["p"], autoDispatch: () => true,
          loadRegistry: async () => JSON.parse(readFileSync(${JSON.stringify(registryPath)}, "utf8")), saveRegistry: async () => {} };
        const result = await schedulerAutoTick(db, { p: { maxActiveWorkers: 1,
          remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: ${tickTotal ?? 1}, codex: 1 } } } },
          { ...deps, manager: async (...args) => runLedger(args.slice(1), cliDeps), borrow: async () => [], notifyPm: async () => {} });
        const intents = db.query("SELECT action,status FROM scheduler_intents ORDER BY eventSeq").all();
        console.log(JSON.stringify({ result, intents, creates }));
        process.exit(0);
      }
      const first = await deps.ensure(getTask(db, "T1"), "author", "claude");
      ${corruptAfterFirst ? `await Bun.write(${JSON.stringify(registryPath)}, "{broken");` : ""}
      const again = await deps.ensure(getTask(db, "T1"), "author", "claude");
      console.log(JSON.stringify({ first, again, creates }));`;
    // Isolated HOME / state / runtime / tmp, and a bridge address nothing listens on: no production auth, registry or bridge.
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home, TMPDIR: tmp,
      CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime, BRIDGE_URL: "http://127.0.0.1:9", BRIDGE_PORT: "9" },
      stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!) as {
      first: Record<string, unknown>; again: Record<string, unknown>; creates: number;
      result: { cards: { step: string }[]; failed: unknown[] }; intents: { action: string; status: string }[];
    };
  };
  const sql = (q: string) => { const db = openLedger(ledgerPath); db.run("PRAGMA foreign_keys=OFF"); db.query(q).run(); closeLedger(ledgerPath); };
  const bindOther = () => sql(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T1', 'author', 'agent-task-one', 's-one', 'claude', 'tmux', 'active', 'i1', 0, 0)`);
  const unbind = () => sql("DELETE FROM scheduler_sessions WHERE taskId='T1'");
  return { dir, repo, registry, ensure, bindOther, unbind, close: () => rmSync(dir, { recursive: true, force: true }) };
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

test("reconcile-capacity: isolated full tick binds the real Git / registry author at full and zero capacity", async () => {
  for (const total of [1, 0]) {
    const f = fixture();
    try {
      f.registry();
      const r = await f.ensure(false, total);
      expect(r.result.failed).toEqual([]);
      expect(r.result.cards[0]).toMatchObject({ step: "session" });
      expect(r.intents).toEqual([{ action: "ensure_session", status: "done" }]);
      expect(r.creates).toBe(0);
    } finally { f.close(); }
  }
}, 30000);

test("registry-stale-proof: corruption after a fresh successful read stays unknown", async () => {
  const f = fixture();
  try {
    f.registry();
    const r = await f.ensure(true);
    expect(r.first).toMatchObject({ kind: "ready", created: false });
    expect(r.again).toMatchObject({ kind: "unknown", reason: expect.stringContaining("registry") });
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
    f.registry({ sessionId: "s-new" }); // the bound session below is a different live one
    f.bindOther();
    expect((await f.ensure()).first).toMatchObject({ kind: "unknown", reason: expect.stringContaining("已绑定另一个作者 session") });
    f.unbind();
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

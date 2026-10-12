/**
 * IDLINK1 [验收线 3] [验收线 4]: an existing author whose registry identity is a proven conflict leaves ensure_session unknown and
 * PM hears it once (card id, executor, reason, way back), not again on later ticks or after a restart; an unreadable registry
 * and a matching author send nothing. Real tick in a child process with its own state dir, synthetic ledger and registry.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { identityNoticeText, noticeIdentityConflict } from "../src/lib/scheduler-identity-notice.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";

const root = new URL("../", import.meta.url).pathname;
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};
type Pass = { notices: { task: string; text: string }[]; intents: { id: string; status: string }[]; steps: string[] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "idlink1-")), state = join(dir, "state"), repo = join(dir, "wt");
  const home = join(dir, "home"), runtime = join(dir, "runtime"), tmp = join(dir, "tmp");
  for (const d of [state, repo, home, runtime, tmp]) mkdirSync(d);
  run(["git", "init", "-q", "-b", "lend/t1"], repo);
  run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], repo);
  const ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  let now = 1000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  createTask(db, at("owner"), { project: "p", id: "BGW-1", title: "后台网关改造", kind: "code", agent: "agent-bgw", branch: "lend/t1",
    extra: { fileGlobs: ["src/x.ts"], localAuthorOnly: true } });
  setWorkflow(db, at("owner"), { taskId: "BGW-1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  closeLedger(ledgerPath);
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { repoDir: repo, requiredChecks: ["check"], agents: { claude: 1, codex: 1 } } } }));
  const registryPath = join(state, "registry.json");
  const author = { runtime: "claude-code", sessionId: "s-one", cwd: repo, projectId: "p", task: "BGW-1 后台网关改造", status: "active" };
  const registry = (over: Record<string, unknown> = {}) => writeFileSync(registryPath, JSON.stringify({ agents: { "agent-bgw": { ...author, ...over } } }));
  /** One process = one service lifetime: `ticks` passes, the notices it sent and the intents left. */
  const pass = async (ticks: number): Promise<Pass> => {
    const script = `import { openLedger } from ${JSON.stringify(root + "src/lib/ledger-store.ts")};
      import { autoTickDeps } from ${JSON.stringify(root + "src/lib/scheduler-auto-deps.ts")};
      import { schedulerAutoTick } from ${JSON.stringify(root + "src/lib/scheduler-auto-tick.ts")};
      import { runLedger } from ${JSON.stringify(root + "src/manager/ledger.ts")};
      import { readFileSync } from "node:fs";
      const db = openLedger(${JSON.stringify(ledgerPath)});
      const notices = [], steps = [];
      const deps = autoTickDeps(db, { registryPath: ${JSON.stringify(registryPath)}, create: async () => ({ ok: false, error: "no" }),
        notifyPm: async (task, text) => { notices.push({ task: task.id, text }); } });
      const cliDeps = { db, actor: "scheduler", registryPath: ${JSON.stringify(registryPath)}, projectIds: ["p"],
        now: () => 2000, autoProjects: () => ["p"], autoDispatch: () => true,
        loadRegistry: async () => JSON.parse(readFileSync(${JSON.stringify(registryPath)}, "utf8")), saveRegistry: async () => {} };
      for (let i = 0; i < ${ticks}; i++) {
        const r = await schedulerAutoTick(db, { p: { maxActiveWorkers: 1,
          remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: 1, codex: 1 } } } },
          { ...deps, manager: async (...args) => runLedger(args.slice(1), cliDeps), borrow: async () => [] });
        steps.push(...r.cards.map((c) => c.step), ...r.failed.map((f) => "failed:" + f.error));
      }
      const intents = db.query("SELECT id, status FROM scheduler_intents WHERE action = 'ensure_session' ORDER BY eventSeq").all();
      console.log(JSON.stringify({ notices, intents, steps }));
      process.exit(0);`;
    // Isolated HOME / state / runtime / tmp, and a bridge address nothing listens on: no production auth, registry or bridge.
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home, TMPDIR: tmp,
      CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime, BRIDGE_URL: "http://127.0.0.1:9", BRIDGE_PORT: "9" },
      stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!) as Pass;
  };
  return { registryPath, registry, pass, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("[验收线 3] registry task not led by the card id: ensure_session unknown, one PM notice; no repeat on later ticks or restart", async () => {
  const f = fixture();
  try {
    f.registry({ task: "后台网关改造" });
    const first = await f.pass(3);
    expect(first.intents).toEqual([{ id: expect.any(String), status: "unknown" }]);
    expect(first.notices).toHaveLength(1);
    const intent = first.intents[0].id, { text } = first.notices[0];
    expect(first.notices[0].task).toBe("BGW-1");
    for (const part of ["BGW-1", "agent-bgw", "不是 BGW-1", "team-link agent-bgw --task \"BGW-1 后台网关改造\"",
      `ledger scheduler-settle ${intent} --from unknown --to cancelled`]) expect(text).toContain(part);
    const restarted = await f.pass(2);
    expect(restarted.notices).toEqual([]);
    expect(restarted.intents).toEqual(first.intents);
  } finally { f.close(); }
}, 60000);

test("[验收线 3] one notice per claimed ensure_session intent; none without a claim; a failed send does not throw", async () => {
  const db = openLedger(":memory:");
  try {
    db.run("PRAGMA foreign_keys=OFF");
    const task = { id: "BGW-1", project: "p", title: "后台网关改造" } as LedgerTask;
    const sent: string[] = [];
    const notify = async (_t: LedgerTask, text: string) => { sent.push(text); };
    const why = "本卡已绑定另一个作者 session（agent-bgw/s-old），不换会话";
    await noticeIdentityConflict(db, task, "agent-bgw", why, notify);
    expect(sent).toEqual([]);
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('i-1', 'BGW-1', 'p', 'write', 'ensure_session', 1, 1, 1, 2, 'submitted', 'r', 0, 0)`).run();
    await noticeIdentityConflict(db, task, "agent-bgw", why, notify);
    await noticeIdentityConflict(db, task, "agent-bgw", why, notify);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("已绑定另一个作者 session（agent-bgw/s-old）");
    expect(sent[0]).toContain("ledger scheduler-settle i-1 --from unknown --to cancelled");
    db.query("UPDATE scheduler_intents SET id = 'i-2'").run();
    await noticeIdentityConflict(db, task, "agent-bgw", why, async () => { throw new Error("bridge down"); });
  } finally { closeLedger(":memory:"); }
});

test("[验收线 4] unreadable registry (身份失读) stays unknown without a notice; a matching author binds without a notice", async () => {
  const f = fixture();
  try {
    writeFileSync(f.registryPath, "{broken");
    const lost = await f.pass(2);
    expect(lost.intents).toEqual([{ id: expect.any(String), status: "unknown" }]);
    expect(lost.notices).toEqual([]);
  } finally { f.close(); }
  const g = fixture();
  try {
    g.registry();
    const ok = await g.pass(2);
    expect(ok.intents[0]).toMatchObject({ status: "done" });
    expect(ok.notices).toEqual([]);
  } finally { g.close(); }
}, 60000);

test("notice text names card, executor, reason and the way back with the card-led task name", () => {
  const text = identityNoticeText({ id: "DNF-1", title: "dnf-1 下单" }, "agent-x", "i-9", "registry 行 agent-y 不是卡上执行者\nagent-x");
  expect(text).toContain("DNF-1");
  expect(text).toContain("执行者 agent-x");
  expect(text).toContain("原因：registry 行 agent-y 不是卡上执行者 agent-x");
  expect(text).toContain("team-link agent-x --task \"dnf-1 下单\"");
  expect(text).toContain("ledger scheduler-settle i-9 --from unknown --to cancelled");
});

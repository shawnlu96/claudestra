import type { AgentInfo } from "../src/manager/core.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openLedger, closeLedger, getTask, listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { runLedger } from "../src/manager/ledger.js";
import { passPace } from "../src/lib/scheduler-yield.js";

const evidence = { ownerWords: "立即开始", ownerAt: 1000, sourceRef: "test:owner" };

test("isolated git sandbox: feature off now starts through real claim/step/settle even when ordinary budget is spent", async () => {
  const root = mkdtempSync(join(tmpdir(), "priority-now-")), repo = join(root, "repo"), path = join(root, "ledger.sqlite");
  mkdirSync(repo);
  const git = async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr).trim() };
  };
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid", "commit", "--allow-empty", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", repo]);
  const db = openLedger(path), project = "prio", pm = "agent-pm", featureId = "ab12-work";
  let creates = 0;
  const agent = (channelId: string): AgentInfo => ({ channelId, projectId: project, project, purpose: "sandbox", created: "", status: "active", notes: "", cwd: repo });
  const agents: Record<string, AgentInfo> = { [pm]: agent("test-pm") };
  try {
    db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
    setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
    createFeature(db, { actor: pm }, { project, slug: "work", title: "work" });
    initDag(db, { actor: pm }, { id: featureId, rev: 1, nodes: [
      { key: "a", oneLine: "start", fileGlobs: ["src/a.ts"] }, { key: "b", oneLine: "wait", deps: ["a"], fileGlobs: ["src/b.ts"] },
    ] });
    setAutostartSwitch(db, { actor: pm }, { project, featureId, on: false, reason: "legacy feature disabled" });
    setPriority(db, { actor: pm, project, dedupKey: "band" }, { target: { kind: "feature", id: featureId }, band: "now", rev: 0, evidence });
    setPriorityMode(db, { actor: pm, project, dedupKey: "mode" }, { mechanism: "priorityNowStart", mode: "on", rev: 0, evidence });
    mkdirSync(join(root, "ledger/docs/tasks"), { recursive: true });
    writeFileSync(join(root, "ledger/docs/tasks/work-a.md"), "# task\n模板:code\n\n## Goal\n");
    const env: StartTickEnv = {
      db, svc: { autoDispatch: true, projects: [project], maxWorkers: () => 3 },
      ledger: (...args) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [project], now: Date.now,
        loadRegistry: async () => ({ socket: "", agents }), saveRegistry: async () => {}, autoDispatch: () => true, autoProjects: () => [project] }),
      plain: async (args) => {
        if (args[0] === "create") { creates++; agents[`agent-${args[1]}`] = agent("fake-executor"); }
        return { ok: true };
      },
      startEnv: () => ({ ledgerDir: join(root, "ledger"), worktreeRoot: join(root, "worktrees"), projectDirs: async () => [repo],
        agentNames: () => Object.keys(agents), exists: existsSync, branchExists: async (cwd, branch) => (await git(cwd, ["rev-parse", "--verify", branch])).ok,
        autoReady: () => null, template: () => null }),
      stepIO: () => ({ git, exists: existsSync, read: (p) => existsSync(p) ? readFileSync(p, "utf8") : null,
        write: (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); },
        remove: (p) => rmSync(p, { force: true }), symlink: symlinkSync, agentExists: (name) => name in agents }),
      readSpec: () => ({ mtimeMs: Date.now() - 120_000, text: "# task\n模板:code\n\n## Goal\n" }),
      quota: async () => ({ status: "unknown", source: null, observedAt: 0, plan: null, reason: "sandbox", windows: [] }),
      notifyPm: async () => {}, memo: new Set(), now: Date.now, attempt: () => crypto.randomUUID(),
    };
    const pace = passPace({}, { budgetMs: 0 }).phase();
    expect(await autostartTick(env, pace)).toEqual([]);
    expect(getTask(db, "work-a")).not.toBeNull();
    expect(getTask(db, "work-b")).toBeNull();
    expect(creates).toBe(1);
    expect(await autostartTick(env, pace)).toEqual([]);
    expect(creates).toBe(1);
    expect(listEvents(db).filter((e) => e.data.op === "autostart_claim")).toHaveLength(1);
  } finally { closeLedger(path); rmSync(root, { recursive: true, force: true }); }
});

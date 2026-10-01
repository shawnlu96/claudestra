/** Shared retirement fixture: real git, registry, and ledger CLI; only archive/kill and PM delivery are simulated. */
import { afterEach } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { TickPace } from "../src/lib/scheduler-yield.js";
import { readLiveAgents, schedulerRetireTick, worktreeDirs, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { getSchedulerSession, type SchedulerSession } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";
import { claudeTmpDirFor, type ClaudeTmpFs } from "../src/lib/scheduler-retire-tmp.js";

type Reply = Record<string, unknown>;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "i28s2-retire-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const root = join(dir, "worktrees"), repo = join(dir, "repo");
  mkdirSync(root);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {} }));
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  let now = 1000;
  const deps = (actor: string): LedgerDeps => ({
    db, actor, registryPath, projectIds: ["p", "q"], now: () => (now += 10),
    loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {},
  });
  const calls: string[][] = [], gitCalls: string[][] = [], notices: string[] = [];
  const replies: Record<string, (args: string[]) => Reply> = {};
  const windows = new Set<string>();
  let tmuxDown = false;
  const setAgent = (name: string, fields: Record<string, unknown> | null) => {
    const reg = JSON.parse(readFileSync(registryPath, "utf8")) as { agents: Record<string, unknown> };
    if (fields) reg.agents[name] = { ...(reg.agents[name] as object | undefined), ...fields }; else delete reg.agents[name];
    writeFileSync(registryPath, JSON.stringify(reg));
  };
  const agent = async (...args: string[]): Promise<Reply> => {
    calls.push(args);
    const own = replies[`${args[0]} ${args[1]}`];
    if (own) return own(args);
    if (args[0] === "kill") { setAgent(args[1], { status: "stopped", pending: undefined }); windows.delete(args[1]); }
    return args[0] === "archive" ? { ok: true, archived: ["a.jsonl"] } : { ok: true, message: `${args[1]} 已销毁。` };
  };
  const retireDeps: RetireDeps = {
    ledger: async (...args) => runLedger(args.slice(1), deps("scheduler")), agent,
    git: async (args) => { gitCalls.push(args); return git(args); },
    exists: existsSync, worktreeRoot: root, notifyPm: async (_t, text) => { notices.push(text); },
    agents: () => readLiveAgents(registryPath, async () => (tmuxDown ? null : [...windows])),
  };
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  mkdirSync(repo);
  sh(repo, "init", "-q"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "a"); sh(repo, "add", "a.txt"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a");

  /** A card at `stage` with scheduler-bound sessions; worktrees: the executor's on a branch, the reviewer's detached. */
  const card = (id: string, stage: string, opts: { project?: string; agent?: string; reviewer?: string | null; transport?: "tmux" | "peer";
    worktrees?: boolean } = {}) => {
    const author = opts.agent ?? `agent-task-${id.toLowerCase()}`;
    createTask(db, { actor: "owner", now: (now += 10) }, { project: opts.project ?? "p", id, title: id, kind: "code", agent: author });
    db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
    const [mine, rv] = worktreeDirs(root, id);
    const bind = (role: "author" | "reviewer", name: string, transport: string) => {
      const ens = `ens:${id}:${role}`;
      db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, ?, 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(ens, id, opts.project ?? "p");
      db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 0)`).run(id, role, name, `s-${id}-${role}`, role === "author" ? "claude" : "codex", transport, ens);
      if (transport !== "peer") { setAgent(name, { status: "active", sessionId: `s-${id}-${role}`, cwd: role === "author" ? mine : rv }); windows.add(name); }
    };
    bind("author", author, opts.transport ?? "tmux");
    if (opts.reviewer !== null) bind("reviewer", opts.reviewer ?? `agent-rv-${id.toLowerCase()}`, opts.transport === "peer" ? "peer" : "acp");
    if (opts.worktrees !== false) {
      sh(repo, "worktree", "add", "-q", mine, "-b", `feat/${id.toLowerCase()}`);
      sh(repo, "worktree", "add", "-q", "--detach", rv);
    }
  };
  const tick = async (projects = ["p"], pace?: TickPace) => {
    const r = await schedulerRetireTick(db, projects, retireDeps, pace);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const row = (id: string, role: "author" | "reviewer") => getSchedulerSession(db, id, role) as SchedulerSession;
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  return {
    db, dir, root, repo, card, tick, row, calls, gitCalls, notices, replies, retireDeps, setAgent, windows,
    tmux: (up: boolean) => { tmuxDown = !up; }, cli: (actor: string, ...a: string[]) => runLedger(a, deps(actor)),
  };
}

/** Real recursive deletion only inside a test-owned OS temp root; never the user's claude-uid tree. */
export function scratchFixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "retire-tmp-test-"))), root = join(temp, "claude-12345"), calls: string[] = [];
  const fs: ClaudeTmpFs = {
    tmpdir: () => temp, uid: () => 12345, realpath: realpathSync, lstat: lstatSync, readdir: readdirSync,
    rm: async (path, opts) => { calls.push(String(path)); expectRmOptions(opts); await rm(path, opts); },
  };
  const dirFor = (cwd: string) => join(root, claudeTmpDirFor(cwd));
  const populate = (cwd: string) => {
    const dir = dirFor(cwd);
    mkdirSync(join(dir, "session-id", "scratchpad"), { recursive: true });
    writeFileSync(join(dir, "session-id", "scratchpad", "output.txt"), "tool output");
    return dir;
  };
  cleanup.push(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, root, fs, calls, dirFor, populate };
}

function expectRmOptions(opts: Parameters<typeof rm>[1]): void {
  if (!opts?.recursive || opts.maxRetries !== 0) throw new Error("cleanup must use recursive rm without retries");
}

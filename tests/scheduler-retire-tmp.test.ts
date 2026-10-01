/**
 * i28-S2b: session temp folders deleted on card retirement. Pure guards (root, slug, one level, symlinks, live sessions, stage,
 * peer) against a scratch temp root, then the retire tick end to end on a real ledger: both folders gone with the settle event
 * saying so, other folders untouched, a refusal told to PM once, a repeated tick a no-op.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claudeTmpDirFor, claudeTmpRoot, cleanSessionTmp, tmpDirVerdict, type TmpCleaner, type TmpStepInput } from "../src/lib/scheduler-retire-tmp.js";
import { readLiveAgents, schedulerRetireTick, worktreeDirs, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { retireIntentId } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "i28s2b-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp root with one session folder (holding a file) per cwd given. */
function tmpRoot(...cwds: string[]): { root: string; dirs: string[] } {
  const root = join(scratch(), "claude-501");
  mkdirSync(root);
  const dirs = cwds.map((c) => claudeTmpDirFor(c, root));
  for (const d of dirs) { mkdirSync(join(d, "sess", "tool-results"), { recursive: true }); writeFileSync(join(d, "sess", "tool-results", "x.txt"), "x"); }
  return { root, dirs };
}

const nodeRm = (calls: string[] = []): TmpCleaner["rm"] => async (p) => { calls.push(p); rmSync(p, { recursive: true }); };

describe("i28-S2b temp root and folder name", () => {
  test("root = realpath(CLAUDE_CODE_TMPDIR || /tmp) + claude-<uid>; no uid → null", () => {
    const base = scratch(), link = join(scratch(), "tmp-link");
    symlinkSync(base, link);
    expect(claudeTmpRoot({ CLAUDE_CODE_TMPDIR: link }, 501)).toBe(join(base, "claude-501"));
    expect(claudeTmpRoot({}, 501)).toBe(join(realpathSync("/tmp"), "claude-501"));
    expect(claudeTmpRoot({}, null)).toBeNull();
    expect(claudeTmpRoot({ CLAUDE_CODE_TMPDIR: join(base, "missing") }, 501)).toBeNull();
  });

  test("folder name follows Claude Code's slug (every non-alphanumeric → -)", () => {
    expect(claudeTmpDirFor("/Users/x/.claude-orchestrator/worktrees/i28-s2b", "/r"))
      .toBe("/r/-Users-x--claude-orchestrator-worktrees-i28-s2b");
    expect(claudeTmpDirFor("/w/rv-t1_a", "/r")).toBe("/r/-w-rv-t1-a");
  });
});

describe("i28-S2b deletion guards", () => {
  test("the root itself, anything outside it, or two levels down is refused", () => {
    const { root } = tmpRoot();
    const outside = scratch();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    for (const d of [root, outside, join(root, "a", "b"), join(root, ".."), `${root}/`]) expect(tmpDirVerdict(d, root, [])).toHaveProperty("refuse");
  });

  test("a symlinked folder or a symlinked root is refused and its target left intact", () => {
    const target = scratch();
    writeFileSync(join(target, "keep.txt"), "k");
    const { root } = tmpRoot();
    symlinkSync(target, join(root, "-w-t1"));
    expect(tmpDirVerdict(join(root, "-w-t1"), root, [])).toHaveProperty("refuse");
    const linkedRoot = join(scratch(), "claude-501");
    symlinkSync(target, linkedRoot);
    expect(tmpDirVerdict(join(linkedRoot, "keep.txt"), linkedRoot, [])).toHaveProperty("refuse");
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  test("a folder a running agent's cwd maps to is refused; a missing folder or root counts as gone", () => {
    const { root, dirs: [d] } = tmpRoot("/w/t1");
    expect(tmpDirVerdict(d, root, [{ name: "agent-pm", cwd: "/w/t1" }])).toEqual({ refuse: "agent-pm 还在跑，它的会话也用这个目录" });
    expect(tmpDirVerdict(d, root, [{ name: "agent-pm", cwd: "/w/t2" }])).toEqual({ rm: d });
    expect(tmpDirVerdict(join(root, "-w-none"), root, [])).toEqual({ gone: join(root, "-w-none") });
    expect(tmpDirVerdict(join(root, "missing", "x"), join(root, "missing"), [])).toHaveProperty("gone");
  });

  const input = (over: Partial<TmpStepInput> = {}): TmpStepInput => ({
    stage: "verified", liveCwds: [],
    checkouts: [{ dir: "/w/t1", role: "author", kept: false }, { dir: "/w/rv-t1", role: "reviewer", kept: false }],
    sessions: [{ role: "author", transport: "tmux", state: "retired" }, { role: "reviewer", transport: "acp", state: "retired" }], ...over,
  });

  test("unfinished cards, unretired sessions, kept worktrees and peer sessions leave their folders alone", async () => {
    for (const stage of ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked", ""]) {
      const { root, dirs } = tmpRoot("/w/t1", "/w/rv-t1"), calls: string[] = [];
      expect(await cleanSessionTmp({ root, rm: nodeRm(calls) }, input({ stage }))).toEqual({ done: [], failed: [] });
      expect(calls).toEqual([]);
      for (const d of dirs) expect(existsSync(d)).toBe(true);
    }
    const { root, dirs: [mine, rv] } = tmpRoot("/w/t1", "/w/rv-t1"), calls: string[] = [];
    const t = { root, rm: nodeRm(calls) };
    expect(await cleanSessionTmp(t, input({ sessions: [{ role: "author", transport: "tmux", state: "retiring" }] }))).toEqual({ done: [], failed: [] });
    await cleanSessionTmp(t, input({ checkouts: [{ dir: "/w/t1", role: "author", kept: true }, { dir: "/w/rv-t1", role: "reviewer", kept: false }],
      sessions: [{ role: "author", transport: "tmux", state: "retired" }, { role: "reviewer", transport: "peer", state: "retired" }] }));
    expect(calls).toEqual([]);
    expect([existsSync(mine), existsSync(rv)]).toEqual([true, true]);
    expect(await cleanSessionTmp(undefined, input())).toEqual({ done: [], failed: [] });
    expect(await cleanSessionTmp({ root: null, rm: nodeRm(calls) }, input())).toEqual({ done: [], failed: [] });
  });

  test("done / cancelled: both folders deleted with fs.rm, a second run finds them gone; an rm failure is reported", async () => {
    for (const stage of ["done", "cancelled"]) {
      const { root, dirs } = tmpRoot("/w/t1", "/w/rv-t1"), calls: string[] = [];
      expect((await cleanSessionTmp({ root, rm: nodeRm(calls) }, input({ stage }))).done).toEqual(["-w-t1 已删", "-w-rv-t1 已删"]);
      expect(calls).toEqual(dirs);
      expect((await cleanSessionTmp({ root, rm: nodeRm(calls) }, input({ stage }))).done).toEqual(["-w-t1 本不在", "-w-rv-t1 本不在"]);
      expect(calls).toHaveLength(2);
    }
    const { root } = tmpRoot("/w/t1");
    const r = await cleanSessionTmp({ root, rm: async () => { throw new Error("EPERM nope"); } }, input());
    expect(r.failed).toEqual([`临时目录 ${join(root, "-w-t1")} 删除失败：EPERM nope`]);
  });
});

describe("i28-S2b in the retire tick", () => {
  function fixture() {
    const dir = scratch(), path = join(dir, "ledger.sqlite"), db = openLedger(path), registryPath = join(dir, "registry.json");
    cleanup.push(() => closeLedger(path));
    const wtRoot = join(dir, "worktrees"), notices: string[] = [];
    const agents: Record<string, unknown> = { "agent-pm": { status: "active", cwd: "/pm/home", channelId: "1" } };
    const save = () => writeFileSync(registryPath, JSON.stringify({ socket: "", agents }));
    save();
    let now = 1000;
    const ledger = async (...a: string[]) => runLedger(a.slice(1), { db, actor: "scheduler", registryPath, projectIds: ["p"], now: () => (now += 10),
      loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {} });
    const card = (id: string, stage: string) => {
      createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code", agent: `agent-${id}` });
      db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
      for (const role of ["author", "reviewer"]) {
        db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
          VALUES (?, ?, 'p', 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 't', 0, 0)`).run(`e:${id}:${role}`, id);
        db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 'claude', 'tmux', 'active', ?, 0, 0)`).run(id, role, `agent-${id}-${role}`, `s-${id}-${role}`, `e:${id}:${role}`);
      }
    };
    const tmp = (root: string, rm = nodeRm()): RetireDeps => ({
      ledger, agent: async (...a) => (a[0] === "kill" ? { ok: true, alreadyStopped: true } : { ok: true, archived: [] }),
      git: async () => ({ code: 1, out: "unused" }), exists: existsSync, worktreeRoot: wtRoot, tmp: { root, rm },
      notifyPm: async (_t, text) => { notices.push(text); }, agents: () => readLiveAgents(registryPath, async () => ["agent-pm"]),
    });
    const settles = (id: string) => listEvents(db, { project: "p", target: id }).filter((e) => e.data.op === "settle" && e.data.to === "done");
    return { db, wtRoot, notices, agents, save, card, tmp, settles };
  }

  test("verified card: both session folders deleted, the settle event says so; other folders untouched; a re-tick is a no-op", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.card("T2", "build");
    const cwds = [...worktreeDirs(f.wtRoot, "T1"), ...worktreeDirs(f.wtRoot, "T2"), "/pm/home"];
    const { root, dirs } = tmpRoot(...cwds), calls: string[] = [];
    const r = await schedulerRetireTick(f.db, ["p"], f.tmp(root, nodeRm(calls)));
    expect(r.cards).toEqual([expect.objectContaining({ taskId: "T1", step: "retired" })]);
    expect(calls).toEqual(dirs.slice(0, 2));
    expect(dirs.map(existsSync)).toEqual([false, false, true, true, true]);
    expect(String(f.settles("T1")[0]?.data.receipt)).toContain("-worktrees-t1 已删");
    expect(String(f.settles("T1")[0]?.data.receipt)).toContain("-worktrees-rv-t1 已删");
    expect(f.notices).toEqual([]);
    expect((await schedulerRetireTick(f.db, ["p"], f.tmp(root, nodeRm(calls)))).cards).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(f.settles("T1")).toHaveLength(1);
  });

  test("a folder a running agent still uses is kept and PM is told once; the card settles and is not retried", async () => {
    const f = fixture();
    f.card("T1", "verified");
    const [mine] = worktreeDirs(f.wtRoot, "T1");
    f.agents["agent-other"] = { status: "active", cwd: mine, channelId: "2", pending: true };
    f.save();
    const { root, dirs } = tmpRoot(...worktreeDirs(f.wtRoot, "T1")), calls: string[] = [];
    const [out] = (await schedulerRetireTick(f.db, ["p"], f.tmp(root, nodeRm(calls)))).cards;
    expect(out.step).toBe("handoff");
    expect(dirs.map(existsSync)).toEqual([true, false]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("agent-other 还在跑");
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("done");
    expect((await schedulerRetireTick(f.db, ["p"], f.tmp(root, nodeRm(calls)))).cards).toEqual([]);
    expect(f.notices).toHaveLength(1);
    expect(existsSync(dirs[0])).toBe(true);
  });
});

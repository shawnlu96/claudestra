/**
 * S2D2 · effects outside the ledger CLI re-check the route at the moment they are sent: the lifecycle executor (archive / remove,
 * git, temp folder, PM notice, ledger record) when a card turns migrating between planning and execution, and the finished-lease
 * sweep that runs before retire (it deletes lock rows directly). Real runLifecycle / retireStep on a temp file ledger.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireWorktree } from "../src/lib/agent-lifecycle-cleanup.js";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import type { Action, Plan } from "../src/lib/agent-lifecycle.js";
import { finishedLeaseSkip } from "../src/lib/ledger-scheduler-lease-finished.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { retireStep } from "../src/lib/scheduler-retire-deps.js";
import { claudeTmpDirFor } from "../src/lib/scheduler-retire-tmp.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { schedulerV2Lifecycle, schedulerV2SkipManager, schedulerV2SkipTask } from "../src/lib/scheduler-v2-skip.js";
import { schedulerV2LifecycleDeps } from "../src/lib/scheduler-v2-skip-lifecycle.js";

const done: (() => void)[] = [];
afterEach(() => { while (done.length) done.pop()!(); });
const hooks = { card: finishedLeaseSkip.card, exclude: finishedLeaseSkip.exclude };

/** Cards TM / TL in project p of a temp file ledger; `migrate(id)` puts a card under a migrating feature (mode file next to it). */
function fixture(prefix: string, stage = "review") {
  const dir = mkdtempSync(join(tmpdir(), prefix)), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const quiet = spyOn(console, "info").mockImplementation(() => {});
  done.push(() => { quiet.mockRestore(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ["TM", "TL"]) createTask(db, { actor: "owner", now: 10 }, { project: "p", id, title: id, kind: "code" });
  db.query("UPDATE tasks SET stage = ?").run(stage);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { fM: { authorityMode: "planning", sharedPlanning: true } } }));
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('fM','p','fM','active','owner',1,1)").run();
  const migrate = (id: string) => {
    writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { fM: { authorityMode: "planning", sharedPlanning: true,
      migrating: { batchId: "b", kind: "execute" } } } }));
    db.query("UPDATE tasks SET featureId = 'fM' WHERE id = ?").run(id);
  };
  return { dir, db, migrate };
}

const action = (taskId: string, cwd: string): Action => ({ agent: `a-${taskId}`, taskId, role: "author", rule: "author_idle", idleMs: 1e9,
  reason: "idle", sessionId: `s-${taskId}`, cwd });

describe("lifecycle: the route is re-checked right before every effect", () => {
  function run(f: ReturnType<typeof fixture>, gated: boolean) {
    const root = join(f.dir, "worktrees");
    mkdirSync(root, { recursive: true });
    const plan = { actions: [action("TM", join(root, "tm")), action("TL", join(root, "tl"))], memory: [], cleanups: [] } as unknown as Plan;
    const effects: string[][] = [];
    let flipped = false;
    const deps: LifecycleDeps = {
      manager: async (...args) => { effects.push(args); return args[0] === "archive" ? { ok: true, archived: [] } : { ok: true, message: "stopped" }; },
      // the snapshot was local; the card turns migrating while the executor looks at the live agents
      agents: async () => {
        if (!flipped) { flipped = true; f.migrate("TM"); }
        return plan.actions.map((a) => ({ name: a.agent, status: "active", sessionId: a.sessionId, cwd: a.cwd, pending: false, window: true }));
      },
      git: async (args) => { effects.push(["git", ...args]); return { code: 0, out: "" }; },
      record: async (r) => { effects.push(["record", r.agent]); },
      exists: () => false, worktreeRoot: root, du: async () => 0, swapPct: async () => 0, now: () => 1,
      cleanupStatePath: join(f.dir, "lifecycle-cleanup.json"), cleanupLedgerPath: join(f.dir, "cleanup-ledger.json"),
    };
    const policy = { ...DEFAULT_LIFECYCLE, mode: "on" as const };
    return { effects, result: gated ? schedulerV2Lifecycle(f.db, runLifecycle)(plan, policy, deps) : runLifecycle(plan, policy, deps) };
  }

  test("a card that turns migrating after planning gets no archive, remove or record; the local card is collected", async () => {
    const f = fixture("s2d2-life-run-");
    const before = listEvents(f.db, { target: "TM" }).length;
    const { effects, result } = run(f, true);
    const out = await result;
    expect(effects.filter((e) => e.includes("a-TM"))).toEqual([]);
    expect(effects).toEqual([["archive", "a-TL"], ["remove", "a-TL"], ["record", "a-TL"]]);
    expect(out.failed).toEqual([{ agent: "a-TM", error: "V2Held: TM retirement route is skip" }]);
    expect(out.done.map((d) => d.agent)).toEqual(["a-TL"]);
    expect(listEvents(f.db, { target: "TM" })).toHaveLength(before);
  });

  test("old red: without the per-effect check the planned card is archived and removed after it turned migrating", async () => {
    const f = fixture("s2d2-life-old-");
    const { effects, result } = run(f, false);
    await result;
    expect(schedulerV2SkipTask(f.db, "TM")).toBe(true);
    expect(effects).toContainEqual(["archive", "a-TM"]);
    expect(effects).toContainEqual(["remove", "a-TM"]);
  });

  test("git, temp folder and PM notice of the skip card's paths are held; the local card's go through", async () => {
    const f = fixture("s2d2-life-paths-");
    const root = join(f.dir, "worktrees"), tmp = join(f.dir, "tmp");
    const sent: string[] = [];
    const aTM = action("TM", join(root, "tm")), aTL = action("TL", join(root, "tl"));
    const base = { git: async (args: string[]) => { sent.push(args.join(" ")); return { code: 0, out: "" }; },
      tmp: { root: tmp, rm: async (p: string) => { sent.push(`rm ${p}`); } }, notifyPm: async (a: Action) => { sent.push(`pm ${a.taskId}`); },
      record: async () => {}, worktreeRoot: root } as unknown as LifecycleDeps;
    const deps = schedulerV2LifecycleDeps(f.db, { actions: [aTM, aTL], memory: [], cleanups: [] }, base);
    f.migrate("TM");
    await expect(deps.git(["-C", join(root, "tm"), "worktree", "remove", join(root, "tm")])).rejects.toThrow("V2Held");
    await expect(deps.git(["-C", join(root, "rv-tm"), "status"])).rejects.toThrow("V2Held");
    await expect(deps.tmp!.rm(claudeTmpDirFor(join(root, "tm"), tmp))).rejects.toThrow("V2Held");
    await expect(deps.notifyPm!(aTM, "x")).rejects.toThrow("V2Held");
    await deps.git(["-C", join(root, "tl"), "worktree", "remove", join(root, "tl")]);
    await deps.tmp!.rm(claudeTmpDirFor(join(root, "tl"), tmp));
    await deps.notifyPm!(aTL, "x");
    expect(sent).toEqual([`-C ${join(root, "tl")} worktree remove ${join(root, "tl")}`, `rm ${claudeTmpDirFor(join(root, "tl"), tmp)}`, "pm TL"]);
  });
});

describe("lifecycle: the checkout cleanup's file effects (archive, unlink) follow a route change during its git and file reads", () => {
  /** When the card turns migrating: during the `nth` git status, the `nth` read of a notes file, or right after the `nth` unlink. */
  type Trigger = { status: number } | { read: number } | { unlink: number };
  /** A real linked worktree per card with two untracked files; the card turns migrating at `when`. */
  async function cleanup(card: "TM" | "TL", when: Trigger) {
    const f = fixture("s2d2-life-files-", "done"), root = join(f.dir, "worktrees"), repo = join(f.dir, "repo"), archive = join(f.dir, "archive");
    mkdirSync(repo);
    mkdirSync(archive);
    for (const args of [["init", "-q", "-b", "main"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c"],
      ["worktree", "add", "-q", "-b", "w", join(root, "tm")]]) expect((await git(["-C", repo, ...args])).code).toBe(0);
    const notes = [join(root, "tm", "a-notes.txt"), join(root, "tm", "b-notes.txt")];
    for (const n of notes) writeFileSync(n, "n");
    const seen = { status: 0, read: 0, unlink: 0 };
    const at = (k: keyof typeof seen) => k in when && ++seen[k] === (when as Record<string, number>)[k] && f.migrate(card);
    const realRead = fsp.readFile, realUnlink = fsp.unlink;
    const read = spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof realRead>) => {
      const r = await realRead(...args);
      if (String(args[0]) === notes[0]) at("read");
      return r;
    }) as typeof realRead);
    const unlink = spyOn(fsp, "unlink").mockImplementation((async (p: Parameters<typeof realUnlink>[0]) => {
      await realUnlink(p);
      at("unlink");
    }) as typeof realUnlink);
    done.push(() => { read.mockRestore(); unlink.mockRestore(); });
    const base = { git: async (args: string[]) => {
      const r = await git(args);
      if (args.includes("status")) at("status");
      return r;
    }, worktreeRoot: root } as unknown as LifecycleDeps;
    const a = action(card, join(root, "tm"));
    const deps = schedulerV2LifecycleDeps(f.db, { actions: [a], memory: [], cleanups: [] }, base);
    const out = await retireWorktree({ ...deps, now: () => 1, cleanupArchiveRoot: archive, cleanupLedgerPath: join(f.dir, "ledger.sqlite") },
      join(root, "tm"), a, [], async () => [], []).then((why) => ({ why }), (e: Error) => ({ error: e.message }));
    return { out, archived: readdirSync(archive).length, notes: notes.map((n) => existsSync(n)), tree: existsSync(join(root, "tm", ".git")),
      skip: schedulerV2SkipTask(f.db, card) };
  }
  const held = { error: "V2Held: TM retirement route is skip" };
  // the file effects' hook returns the hold as the reason the checkout is kept: retireWorktree gets no new throw path
  const kept = (why: string) => ({ why: expect.stringMatching(new RegExp(`^V2Held: TM retirement route is skip${why}`)) });

  test("turns migrating during the first git status: nothing archived, the files stay, held", async () => {
    expect(await cleanup("TM", { status: 1 })).toEqual({ out: held, archived: 0, notes: [true, true], tree: true, skip: true });
  });

  test("turns migrating during the re-check's git status: no untracked file is unlinked, held", async () => {
    expect(await cleanup("TM", { status: 2 })).toMatchObject({ out: held, notes: [true, true], tree: true, skip: true });
  });

  test("turns migrating while the survey reads a file (after the last git read): nothing archived, the files stay, held", async () => {
    expect(await cleanup("TM", { read: 1 })).toEqual({ out: kept("$"), archived: 0, notes: [true, true], tree: true, skip: true });
  });

  test("turns migrating while the re-check survey reads a file: nothing is unlinked, held", async () => {
    expect(await cleanup("TM", { read: 2 })).toEqual({ out: kept("（归档已在 "), archived: 1, notes: [true, true], tree: true, skip: true });
  });

  test("turns migrating between two awaited unlinks: the second file stays, held", async () => {
    expect(await cleanup("TM", { unlink: 1 })).toEqual({ out: kept("（归档已在 "), archived: 1, notes: [false, true], tree: true, skip: true });
  });

  test("a local card's checkout is archived and removed as before", async () => {
    expect(await cleanup("TL", { status: 99 })).toEqual({ out: { why: null }, archived: 1, notes: [false, false], tree: false, skip: false });
  });
});

describe("retire: the finished-lease sweep before retirement leaves skip cards' locks alone", () => {
  function sweep(stage: string, tmIntent = "done") {
    const f = fixture("s2d2-retire-sweep-", stage);
    for (const id of ["TM", "TL"]) {
      f.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason,
        createdAt, updatedAt) VALUES (?, ?, 'p', 'write', 'dispatch', 0, 1, 1, 2, ?, 'test', 0, 0)`).run(`i-${id}`, id, id === "TM" ? tmIntent : "done");
      f.db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, ?, ?, 1, 'card')")
        .run(`src/${id}.ts`, id, `i-${id}`);
    }
    f.migrate("TM");
    const locks = () => (f.db.query("SELECT taskId FROM scheduler_resources ORDER BY taskId").all() as { taskId: string }[]).map((r) => r.taskId);
    const calls: string[][] = [];
    const ledger = schedulerV2SkipManager(f.db, async (...args) => { calls.push(args); return { ok: false, error: "test: not retired" }; });
    const config = { projects: { p: {} } } as unknown as SchedulerConfig;
    return { f, locks, calls, go: () => retireStep(f.db, config, ledger, () => {}, undefined) };
  }

  test("verified cards: the local card's stranded locks are freed, the migrating card's stay (real retireStep)", async () => {
    const s = sweep("verified"), before = listEvents(s.f.db, { target: "TM" }).length;
    await s.go();
    expect(s.locks()).toEqual(["TM"]);
    expect(s.calls.filter((c) => c.includes("TM"))).toEqual([]);
    expect(listEvents(s.f.db, { target: "TM" })).toHaveLength(before);
  });

  test("old red: without the hook the same sweep deletes the migrating card's lock rows", async () => {
    const s = sweep("verified");
    finishedLeaseSkip.card = undefined;
    finishedLeaseSkip.exclude = undefined;
    done.push(() => Object.assign(finishedLeaseSkip, hooks));
    await s.go();
    expect(s.locks()).toEqual([]);
  });

  test("a finished card with an open write dispatch is not reconciled while it is skip", async () => {
    const s = sweep("done", "pending");
    await s.go();
    expect(s.f.db.query("SELECT status FROM scheduler_intents WHERE id = 'i-TM'").get()).toEqual({ status: "pending" });
    expect(s.locks()).toEqual(["TM"]);
  });
});

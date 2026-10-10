/**
 * LIFE4: a pending cleanup that only a person can resolve (uncommitted change, a main repository) is not re-recorded while nothing changed,
 * is retried at most every 6 hours (at once when its `git status --porcelain` changes), and PM hears of it once per (agent, regAt, kind).
 * Real temporary git repositories; the lifecycle's deps (ledger write, du, agents, clock) are injected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANUAL_BACKOFF_MS, manualDue, manualKind, manualNotice } from "../src/lib/agent-lifecycle-backoff.js";
import { gatedCollect } from "../src/lib/agent-lifecycle-cleanup-gate.js";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { cardWorkerIndex, pendingCleanups, recordWorkerRetire, registerWorker, type RetireRecord } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type Action } from "../src/lib/agent-lifecycle.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const H = 3_600_000, NOW = 100 * H;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

/** A repo with a linked worktree `wt` under `root`, a ledger with a finished card C1, and agent-d registered then retired with `wt` left. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "life4-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"), root = join(dir, "worktrees"), wt = join(root, "w1");
  mkdirSync(repo); mkdirSync(root);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "tracked\n");
  sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "base");
  sh(repo, "worktree", "add", "-q", "--detach", wt);
  const path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => closeLedger(path));
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "C1", title: "C1", kind: "code" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C1'").run();
  registerWorker(db, { agent: "agent-d", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
  recordWorkerRetire(db, "scheduler", { agent: "agent-d", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
    bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
  return { dir, repo, root, wt, db, path };
}

const retireEvents = (db: ReturnType<typeof openLedger>) => listEvents(db, { project: "p" })
  .filter((e) => (e.data as { op?: string }).op === "worker_retire" && (e.data as { retry?: boolean }).retry);

describe("manual-only pending cleanup through the lifecycle (injected deps)", () => {
  test("dirty worktree: 3 ticks → 1 event + 1 PM notice; content change → one more event, no second notice; clean → closed", async () => {
    const { dir, root, wt, db, path } = fixture();
    writeFileSync(join(wt, "a.txt"), "changed\n");
    let t = NOW, duCalls = 0;
    const attempts = () => duCalls / 2; // collect measures before and after each attempt
    const deps = (): LifecycleDeps => ({ manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: root, agents: async () => [],
      du: async (paths) => { if (paths.includes(wt)) duCalls++; return 2 * 1048576; }, swapPct: async () => 0,
      record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t,
      cleanupLedgerPath: path, cleanupStatePath: join(dir, "cleanup.json"), cleanupArchiveRoot: join(dir, "archive") });
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = async () => (await runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db),
      foreign: new Set(), master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, deps())).failed.map((f) => f.error);

    // three passes, 2.5 h apart (past LIFE3's 2 h cap, under 6 h): one attempt, one event, one notice
    const notices: string[] = [];
    for (let i = 0; i < 3; i++) { notices.push(...await tick()); t += 2.5 * H; }
    expect(attempts()).toBe(1);
    expect(retireEvents(db).length).toBe(1);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(wt);
    expect(notices[0]).toContain("有未提交改动");
    expect(notices[0]).toContain(join(wt, "a.txt"));
    expect(notices[0]).toContain("共 2.0MB");
    // 6 h after the last try it is retried once more: same result → no event, no notice
    t = NOW + MANUAL_BACKOFF_MS;
    expect(await tick()).toEqual([]);
    expect([attempts(), retireEvents(db).length]).toEqual([2, 1]);
    // the uncommitted content changes → retried on the very next pass, recorded once, PM not told again (same agent, regAt, kind)
    writeFileSync(join(wt, "b.ts"), "b"); sh(wt, "add", "b.ts");
    t += 60_000;
    expect(await tick()).toEqual([]);
    expect([attempts(), retireEvents(db).length]).toEqual([3, 2]);
    expect(String((retireEvents(db)[1].data as { steps: string[] }).steps)).toContain("b.ts");
    t += 60_000;
    expect(await tick()).toEqual([]);
    expect(attempts()).toBe(3);
    // PM resolves it: the porcelain changed, so the next pass retries and the cleanup closes as before (git worktree remove, no --force)
    sh(wt, "reset", "-q", "--hard"); rmSync(join(wt, "b.ts"), { force: true });
    t += 60_000;
    expect(await tick()).toEqual([]);
    expect([existsSync(wt), pendingCleanups(db)]).toEqual([false, []]);
  });

  test("main repository under the root: classified main_repo, reported once, backs off 6 h, never touched", async () => {
    const { dir, root, db, path } = fixture();
    const main = join(root, "main1");
    mkdirSync(main); sh(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "x"), "x"); sh(main, "add", "."); sh(main, "commit", "-qm", "m");
    registerWorker(db, { agent: "agent-m", sessionId: "s2", taskId: "C1", role: "author", createdBy: "pm", now: 6 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-m", sessionId: "s2", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: main, tmp: null }], retry: false });
    db.query("DELETE FROM worker_agents WHERE agent = 'agent-d'").run();
    let t = NOW;
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = async () => (await runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db),
      foreign: new Set(), master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, { manager: async () => ({ ok: true }), git,
      exists: existsSync, worktreeRoot: root, agents: async () => [], du: async () => 0, swapPct: async () => 0,
      record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t, cleanupLedgerPath: path,
      cleanupStatePath: join(dir, "cleanup.json"), cleanupArchiveRoot: join(dir, "archive") })).failed.map((f) => f.error);
    const first = await tick();
    expect(first.length).toBe(1);
    expect(first[0]).toContain("是主仓库而不是 linked worktree");
    expect(first[0]).toContain(main);
    for (const dt of [10 * 60_000, 3 * H, 5.9 * H]) { t = NOW + dt; expect(await tick()).toEqual([]); }
    t = NOW + MANUAL_BACKOFF_MS; expect(await tick()).toEqual([]);
    expect(retireEvents(db).filter((e) => (e.data as { agent: string }).agent === "agent-m").length).toBe(1);
    expect(existsSync(join(main, ".git"))).toBe(true);
  });
});

describe("gate: one PM notice per (agent, regAt, kind)", () => {
  test("same kind with changed content → recorded, not re-reported; kind changes (dirty → main repo) → reported again", async () => {
    const { dir, wt } = fixture();
    const a: Action = { agent: "agent-d", sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: "cleanup_retry", reason: "t", idleMs: null,
      entries: [{ checkout: wt, tmp: null }] };
    let records = 0, t = NOW;
    const d = { now: () => t, git, du: async () => 0, cleanupStatePath: join(dir, "cleanup.json"), record: async (_r: RetireRecord) => { records++; } };
    const once = (why: string) => gatedCollect(a, d, async (a, wrapped) => {
      await wrapped.record({ agent: a.agent, sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: a.rule, reason: "t", idleMs: null,
        bytesBefore: 0, bytesAfter: 0, steps: [`worktree 没删 ${wt}：${why}`], now: t, pending: a.entries!, retry: true });
      return { freed: 0, left: 1 };
    }).then((o) => { t += 60_000; return o; });
    expect(await once("有已跟踪改动，原样保留交 PM：已修改 1：a.txt")).toHaveProperty("notice");
    expect(await once("有已跟踪改动，原样保留交 PM：已修改 2：a.txt, b.ts")).toMatchObject({ quiet: true });
    const again = await once("是主仓库而不是 linked worktree，不碰");
    expect((again as { notice?: string }).notice).toContain("是主仓库而不是 linked worktree");
    expect(records).toBe(3);
  });
});

describe("store: a retry with no progress writes nothing", () => {
  test("3 identical retries → 1 event, row unchanged; changed steps → one more; finished → closed", () => {
    const { wt, db } = fixture();
    const before = db.query("SELECT reason FROM worker_agents WHERE agent = 'agent-d'").get();
    const r: RetireRecord = { agent: "agent-d", sessionId: "s1", taskId: "C1", role: "author", rule: "cleanup_retry", reason: "t", idleMs: null,
      bytesBefore: 1, bytesAfter: 1, steps: [`worktree 没删 ${wt}：有已跟踪改动，原样保留交 PM`], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: true, regAt: 5 };
    for (let i = 0; i < 3; i++) recordWorkerRetire(db, "scheduler", { ...r, now: NOW + i });
    expect(retireEvents(db).length).toBe(1);
    expect(db.query("SELECT reason FROM worker_agents WHERE agent = 'agent-d'").get()).toEqual(before);
    recordWorkerRetire(db, "scheduler", { ...r, steps: [`worktree 没删 ${wt}：有已跟踪改动，原样保留交 PM（b.ts）`] });
    expect(retireEvents(db).length).toBe(2);
    recordWorkerRetire(db, "scheduler", { ...r, steps: [`worktree 已清 ${wt}`], pending: [] });
    expect([retireEvents(db).length, pendingCleanups(db)]).toEqual([3, []]);
  });
});

describe("classification and due rule", () => {
  const e = (checkout: string) => ({ checkout, tmp: null });
  test("manual only when every entry left is dirty or a main repo; anything that may clear by itself retries as usual", () => {
    expect(manualKind({ pending: [e("/w/a")], steps: ["worktree 没删 /w/a：有已跟踪改动，原样保留交 PM（不搬未跟踪文件）：已修改 1：a"] })).toBe("dirty");
    expect(manualKind({ pending: [e("/w/a")], steps: ["worktree 没删 /w/a：是主仓库而不是 linked worktree，不碰"] })).toBe("main_repo");
    expect(manualKind({ pending: [e("/w/a"), e("/w/b")], steps: ["worktree 没删 /w/a：是主仓库而不是 linked worktree，不碰",
      "worktree 没删 /w/b：有已跟踪改动，原样保留交 PM"] })).toBe("dirty");
    expect(manualKind({ pending: [e("/w/a"), e("/w/b")], steps: ["worktree 没删 /w/a：有已跟踪改动", "worktree 没删 /w/b：agent-z 还在这里工作（agent 没停）"] })).toBeNull();
    expect(manualKind({ pending: [e("/w/a")], steps: ["worktree 没删 /w/a：卡 C1 还持有调度资源 r（write 写租约），不动"] })).toBeNull();
    expect(manualKind({ pending: [e("/w/a")], steps: ["临时目录没删：x"] })).toBeNull();
    expect(manualKind({ pending: [], steps: [] })).toBeNull();
  });
  test("due after 6 h, on a porcelain change, when it cannot be read, or when the clock went back", () => {
    const m = { kind: "dirty" as const, porcelain: "p1", at: NOW };
    expect(manualDue(m, NOW + MANUAL_BACKOFF_MS - 1, "p1")).toBe(false);
    expect(manualDue(m, NOW + MANUAL_BACKOFF_MS, "p1")).toBe(true);
    expect(manualDue(m, NOW + 1, "p2")).toBe(true);
    expect(manualDue(m, NOW + 1, null)).toBe(true);
    expect(manualDue(m, NOW - 1, "p1")).toBe(true);
  });
  test("notice lists the directory, the reason, the first 5 uncommitted files and their size", () => {
    const files = Array.from({ length: 7 }, (_, i) => `/w/a/f${i}`);
    const n = manualNotice("agent-q", "dirty", [e("/w/a")], ["worktree 没删 /w/a：有已跟踪改动，原样保留交 PM"], files, 3 * 1048576);
    expect(n).toContain("/w/a");
    expect(n).toContain("有已跟踪改动");
    expect(n).toContain("未提交文件 7 项（前 5：/w/a/f0, /w/a/f1, /w/a/f2, /w/a/f3, /w/a/f4）共 3.0MB");
    expect(n).not.toContain("f5");
  });
});

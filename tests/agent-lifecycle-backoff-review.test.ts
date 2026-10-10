/**
 * LIFE4 round 2 (review findings): the PM notice goes out through the existing PM channel (and only a delivered one counts), once per
 * (agent, regAt, kind) across kind switches, with real (unquoted) file names and sizes; a staged content change on the same path is
 * recorded; a reason is read only after the checkout, never from a directory name. Real temporary git repositories, injected deps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualKind, porcelainOf, v2Paths } from "../src/lib/agent-lifecycle-backoff.js";
import { gatedCollect } from "../src/lib/agent-lifecycle-cleanup-gate.js";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { ledgerFacts, lifecycleNotifier } from "../src/lib/agent-lifecycle-deps.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { cardWorkerIndex, pendingCleanups, recordWorkerRetire, registerWorker, type RetireRecord } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type Action } from "../src/lib/agent-lifecycle.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const H = 3_600_000, NOW = 100 * H;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};
/** Sizes what exists, like production du: a wrongly quoted path is "not there" and adds 0. */
const du = async (paths: string[]) => paths.filter((p) => existsSync(p)).reduce((n, p) => n + statSync(p).size, 0);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "life4r-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"), root = join(dir, "worktrees"), wt = join(root, "w1");
  mkdirSync(repo); mkdirSync(root);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "tracked\n"); writeFileSync(join(repo, "证据.txt"), "x\n"); writeFileSync(join(repo, "old.txt"), "o\n");
  sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "base");
  sh(repo, "worktree", "add", "-q", "--detach", wt);
  const path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => closeLedger(path));
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "C1", title: "C1", kind: "code" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C1'").run();
  registerWorker(db, { agent: "agent-d", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
  recordWorkerRetire(db, "scheduler", { agent: "agent-d", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
    bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
  return { dir, root, wt, db, path };
}

const retireEvents = (db: ReturnType<typeof openLedger>) => listEvents(db, { project: "p" })
  .filter((e) => (e.data as { op?: string }).op === "worker_retire" && (e.data as { retry?: boolean }).retry);

function lifecycle(f: ReturnType<typeof fixture>, extra: Partial<LifecycleDeps>) {
  let t = NOW;
  const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
  const deps = (): LifecycleDeps => ({ manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: f.root, agents: async () => [],
    du, swapPct: async () => 0, record: async (r) => recordWorkerRetire(f.db, "scheduler", r), now: () => t,
    cleanupLedgerPath: f.path, cleanupStatePath: join(f.dir, "cleanup.json"), cleanupArchiveRoot: join(f.dir, "archive"), ...extra });
  const tick = async () => (await runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(f.db), ...ledgerFacts(f.db),
    foreign: new Set(), master: new Set(), swapPct: 10, pending: pendingCleanups(f.db) }), on, deps())).failed.map((x) => x.error);
  return { tick, at: (v: number) => { t = v; }, now: () => t };
}

describe("pm-delivery: the notice goes through the PM channel, and only a delivered one counts", () => {
  test("3 passes → notifyPm once (directory, reason, real file names, size), nothing in the failed log; a later change is recorded, not re-sent", async () => {
    const f = fixture();
    writeFileSync(join(f.wt, "证据.txt"), Buffer.alloc(2 * 1048576, 1));
    const sent: { agent: string; text: string }[] = [];
    const l = lifecycle(f, { notifyPm: async (a, text) => { sent.push({ agent: a.agent, text }); } });
    for (let i = 0; i < 3; i++) { expect(await l.tick()).toEqual([]); l.at(l.now() + 2.5 * H); }
    expect(sent.length).toBe(1);
    expect(sent[0].agent).toBe("agent-d");
    for (const s of [f.wt, "有未提交改动", join(f.wt, "证据.txt"), "共 2.0MB"]) expect(sent[0].text).toContain(s);
    expect(retireEvents(f.db).length).toBe(1);
  });

  test("a failed send is not counted: reported in the failed log, retried on the usual back-off, then sent once", async () => {
    const f = fixture();
    writeFileSync(join(f.wt, "a.txt"), "changed\n");
    let down = true, sent = 0;
    const l = lifecycle(f, { notifyPm: async () => { if (down) throw new Error("bridge down"); sent++; } });
    const first = await l.tick();
    expect(first.length).toBe(1);
    expect(first[0]).toContain("报 PM 没送达");
    down = false;
    l.at(NOW + 3 * H); // past LIFE3's back-off, under 6 h: not told yet, so the manual back-off does not hold it
    expect(await l.tick()).toEqual([]);
    expect(sent).toBe(1);
    expect(retireEvents(f.db).length).toBe(1); // same result: no second event
    l.at(NOW + 5 * H);
    expect(await l.tick()).toEqual([]);
    expect(sent).toBe(1);
  });

  test("production wiring: the card's project, scheduler identity, liveness passed on; a stopped pass sends nothing", async () => {
    const f = fixture();
    const config = { projects: { other: {} } } as unknown as SchedulerConfig;
    const calls: { project: string; text: string; alive: boolean }[] = [];
    const send = async (_db: unknown, project: string, text: string, o: { fromName: string; stillActive?: () => boolean }) => {
      expect(o.fromName).toBe("scheduler");
      calls.push({ project, text, alive: o.stillActive!() });
    };
    const a = { agent: "agent-d", taskId: "C1" } as Action;
    await lifecycleNotifier(f.db, config, () => {}, send)(a, "hi");
    expect(calls).toEqual([{ project: "p", text: "hi", alive: true }]);
    await lifecycleNotifier(f.db, config, () => {}, send)({ ...a, taskId: null }, "no card");
    expect(calls[1].project).toBe("other");
    const stopped = () => { throw new SchedulerStopped("lease lost"); };
    await expect(lifecycleNotifier(f.db, config, stopped, send)(a, "x")).rejects.toThrow("lease lost");
    expect(calls.length).toBe(2);
  });
});

describe("notice-history: once per (agent, regAt, kind) across kind switches", () => {
  test("dirty → exception → same dirty: persisted notice history prevents a second PM notification", async () => {
    const { dir, wt } = fixture();
    writeFileSync(join(wt, "a.txt"), "changed\n");
    const a: Action = { agent: "agent-d", sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: "cleanup_retry", reason: "t", idleMs: null,
      entries: [{ checkout: wt, tmp: null }] };
    let t = NOW, sent = 0;
    const d = { now: () => t, git, du, cleanupStatePath: join(dir, "cleanup.json"), record: async (_r: RetireRecord) => {},
      notifyPm: async () => { sent++; } };
    const dirty = () => gatedCollect(a, d, async (action, wrapped) => {
      await wrapped.record({ agent: action.agent, sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: action.rule, reason: "t", idleMs: null,
        bytesBefore: 0, bytesAfter: 0, steps: [`worktree 没删 ${wt}：有已跟踪改动`], now: t, pending: action.entries!, retry: true });
      return { freed: 0, left: 1 };
    });
    await dirty();
    expect(sent).toBe(1);
    t += 60_000;
    await expect(gatedCollect(a, d, async () => { throw new Error("registry unavailable"); })).rejects.toThrow("registry unavailable");
    t += 60_000;
    await dirty();
    expect(sent).toBe(1);
  });

  test("dirty → main repo → dirty → holder → dirty: one notice per kind, never a second dirty one", async () => {
    const { dir, wt } = fixture();
    const a: Action = { agent: "agent-d", sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: "cleanup_retry", reason: "t", idleMs: null,
      entries: [{ checkout: wt, tmp: null }] };
    let t = NOW;
    const sent: string[] = [];
    const d = { now: () => t, git, du, cleanupStatePath: join(dir, "cleanup.json"), record: async (_r: RetireRecord) => {},
      notifyPm: async (_a: Action, text: string) => { sent.push(text); } };
    const once = (why: string) => gatedCollect(a, d, async (a, wrapped) => {
      await wrapped.record({ agent: a.agent, sessionId: "s1", regAt: 5, taskId: "C1", role: "author", rule: a.rule, reason: "t", idleMs: null,
        bytesBefore: 0, bytesAfter: 0, steps: [`worktree 没删 ${wt}：${why}`], now: t, pending: a.entries!, retry: true });
      return { freed: 0, left: 1 };
    }).then(() => { t += 60_000; });
    for (const why of ["有已跟踪改动，原样保留交 PM：已修改 1：a.txt", "是主仓库而不是 linked worktree，不碰", "有已跟踪改动，原样保留交 PM：已修改 1：a.txt",
      "agent-z 还在这里工作（agent 没停）", "有已跟踪改动，原样保留交 PM：已修改 2：a.txt, b.ts"]) await once(why);
    expect(sent.length).toBe(2);
    expect(sent[0]).toContain("有未提交改动");
    expect(sent[1]).toContain("是主仓库而不是 linked worktree");
  });
});

describe("quoted-files: real paths from NUL-separated porcelain", () => {
  test("a CJK name, a name with a tab and a rename keep their real paths; size counts them", async () => {
    const { wt } = fixture();
    writeFileSync(join(wt, "证据.txt"), Buffer.alloc(3000, 1));
    writeFileSync(join(wt, "tab\there.txt"), "t");
    sh(wt, "mv", "old.txt", "新名.txt");
    const p = (await porcelainOf(git, [wt]))!;
    expect(p.files.sort()).toEqual([join(wt, "tab\there.txt"), join(wt, "新名.txt"), join(wt, "证据.txt")].sort());
    expect(await du(p.files)).toBe(3000 + 1 + 2);
  });
  test("parser: headers skipped, rename's original path not listed, unmerged and untracked read", () => {
    const out = ["# branch.oid x", "1 .M N... 100644 100644 100644 h1 h2 a b.txt", "2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt", "old.txt",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 c.txt", "? 未跟踪.txt", ""].join("\0");
    expect(v2Paths(out)).toEqual(["a b.txt", "new name.txt", "c.txt", "未跟踪.txt"]);
  });
});

describe("content-event: a staged content change on the same path is recorded once", () => {
  test("a.txt staged1 → first pass; staged2 → next pass retries and writes one more event (same file name and kind)", async () => {
    const f = fixture();
    writeFileSync(join(f.wt, "a.txt"), "staged1\n"); sh(f.wt, "add", "a.txt");
    const l = lifecycle(f, { notifyPm: async () => {} });
    await l.tick();
    l.at(NOW + 60_000); await l.tick();
    expect(retireEvents(f.db).length).toBe(1);
    writeFileSync(join(f.wt, "a.txt"), "staged2\n"); sh(f.wt, "add", "a.txt");
    l.at(NOW + 120_000); expect(await l.tick()).toEqual([]);
    expect(retireEvents(f.db).length).toBe(2);
    l.at(NOW + 180_000); await l.tick();
    expect(retireEvents(f.db).length).toBe(2);
  });
});

describe("reason-match: only the reason after the checkout classifies", () => {
  test("a directory named like a manual reason does not turn a holder block into a manual one", () => {
    const e = { checkout: "/w/有已跟踪改动", tmp: null };
    expect(manualKind({ pending: [e], steps: ["worktree 没删 /w/有已跟踪改动：agent-z 还在这里工作（agent 没停）"] })).toBeNull();
    expect(manualKind({ pending: [e], steps: ["worktree 没删 /w/有已跟踪改动：卡 C1 还持有调度资源 r（是主仓库而不是 linked worktree）"] })).toBeNull();
    expect(manualKind({ pending: [e], steps: ["worktree 没删 /w/有已跟踪改动：有已跟踪改动，原样保留交 PM"] })).toBe("dirty");
  });
});

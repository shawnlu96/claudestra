/**
 * dispatch-recovery-PRIVLOCK2: a private-repo card's file locks shrink to the PR's own files on the merge-stage foreign_repo
 * escalation (scheduler-merge-handoff-private.ts), behind recovery key privateMergeNarrow; the escalation itself is as on main.
 * The tick reads through the fixture's query_only handle; gh / git are a fake command, the clone lookup a fake directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { foreignRepoReason, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { narrowPrivateMerge, PRIVATE_READ_BUDGET_MS, PRIVATE_READ_MS, setPrivateNarrowIoForTest } from "../src/lib/scheduler-merge-handoff-private.js";
import { autoFixture, H1, P2, toBuild } from "./scheduler-auto-helpers.js";

const R = "repo:acme/cloud/";
const PR = "https://github.com/acme/cloud/pull/9";
const DIR = "/fake/clones/cloud-private";
const GLOBS = ["src/lib/acp/*", "src/bridge/acp-link.ts", "src/lib/acp-turn.ts", "src/lib/acp-host.ts", "src/lib/acp-ports.ts", "src/lib/acp-env.ts",
  "src/lib/acp-pool.ts", "src/lib/acp-log.ts", "tests/acp-*.test.ts", "docs/acp.md", "src/lib/acp-relay.ts", "src/lib/acp-codec.ts"].map((g) => R + g);
const ESCALATION = { kind: "escalate" as const, code: "foreign_repo", reason: foreignRepoReason("acme/cloud").slice("foreign_repo：".length) };
const PR_FILES = ["src/lib/acp/session.ts", "src/bridge/acp-link.ts"];
const NARROWED = [`${R}src/bridge/acp-link.ts`, `${R}src/lib/acp/session.ts`];
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (code: number | null, timedOut = false): BoundedResult =>
  ({ code, stdout: "", stderr: "fatal: could not read from https://secret@github.com/acme/cloud.git in /Users/he/clones", timedOut });

interface World { gh: Partial<{ state: string; headRefOid: string; baseRefName: string }> | BoundedResult; origin: string; fetch: BoundedResult;
  diff: string | BoundedResult; dir: string | null; calls: { argv: string[]; timeoutMs: number }[];
  /** fake clock: a step takes delay[gh | config | fetch | diff] ms, or times out at its timeoutMs when that is shorter */
  now: number; delay: Record<string, number>; onGh?: () => void }

afterEach(() => { setForeignRepoLookupForTest({ project: null, origin: null }); setPrivateNarrowIoForTest(null); });

function fakeIo(w: World) {
  setPrivateNarrowIoForTest({
    repoDir: (_p, repo) => (repo.toLowerCase() === "acme/cloud" ? w.dir : null),
    clock: () => w.now,
    command: async (argv, opts) => {
      w.calls.push({ argv, timeoutMs: opts.timeoutMs });
      const took = w.delay[argv[0] === "gh" ? "gh" : argv[1]!] ?? 0;
      w.now += Math.min(took, opts.timeoutMs);
      if (took > opts.timeoutMs) return fail(null, true);
      if (argv[0] === "gh") w.onGh?.();
      if (argv[0] === "gh") return "code" in w.gh ? w.gh as BoundedResult : ok(JSON.stringify({ state: "OPEN", headRefOid: H1, baseRefName: "main", mergeCommit: null, ...w.gh }));
      if (argv[1] === "config") return ok(`${w.origin}\n`);
      if (argv[1] === "fetch") return w.fetch;
      if (argv[1] === "diff") return typeof w.diff === "string" ? ok(w.diff) : w.diff;
      throw new Error(`unexpected ${argv.join(" ")}`);
    },
  });
}

/** T1 on acme/cloud with twelve repo: globs, driven to merge at H1 on PR; then the project repository is the public one. */
async function privateAtMerge(mode: RecoveryMode | null = "on", files = PR_FILES) {
  setForeignRepoLookupForTest({ project: null, origin: null });
  setPrivateNarrowIoForTest(null);
  const f = autoFixture();
  f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: GLOBS }));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  setForeignRepoLookupForTest({ project: () => "shawnlu96/claudestra" });
  const w: World = { gh: {}, origin: "git@github.com:acme/cloud.git", fetch: ok(""), diff: files.map((p) => `${p}\0`).join(""), dir: DIR, calls: [], now: 1_000, delay: {} };
  fakeIo(w);
  if (mode) f.tickDeps.recoveryPolicy = () => ({ mode, manualAfterMs: null, source: "config" });
  const locks = (taskId = "T1") => (f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? AND scope = 'card' AND resource LIKE 'repo:%' ORDER BY resource")
    .all(taskId) as { resource: string }[]).map((r) => r.resource);
  const events = (op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
  return { f, w, locks, events };
}

/** planIntent is where the scheduler refuses an overlapping lock; T2 is auto only for this one call. */
function dispatchRival(f: ReturnType<typeof autoFixture>, resources: string[]) {
  if (!getTask(f.db, "T2")) createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "rival", kind: "code", agent: "agent-task-two", extra: { fileGlobs: resources } });
  const flip = (mode: "auto" | "manual") => setWorkflow(f.db, f.at("owner"), { taskId: "T2", taskRev: getTask(f.db, "T2")!.rev, workflowRev: getWorkflow(f.db, "T2")?.rev,
    template: "code", templateVersion: 2, mode, authorFamily: "claude", fallback: "x", ...(mode === "manual" ? { reason: "pm_hold: 测试里只派这一单" } : {}) });
  flip("auto");
  try {
    const seq = (f.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
    return planIntent(f.db, f.at("scheduler"), { id: `T2:write:${seq}`, taskId: "T2", taskRev: getTask(f.db, "T2")!.rev, workflowRev: getWorkflow(f.db, "T2")!.rev,
      causalSeq: seq, node: "write", action: "dispatch", recipient: "agent-task-two", reason: "派单", resources: [...resources, "task:T2"] });
  } finally { flip("manual"); }
}

/** The escalation as main writes it: one fallback_manual with foreign_repo's reason, the card manual, PM told once. */
function escalatedAsMain(s: Awaited<ReturnType<typeof privateAtMerge>>, out: unknown) {
  expect(out).toMatchObject({ step: "manual", detail: foreignRepoReason("acme/cloud") });
  expect(getWorkflow(s.f.db, "T1")!.mode).toBe("manual");
  expect(s.f.notices.filter((n) => n.includes("退回人工"))).toEqual([`[调度引擎] T1 退回人工，请接手：${foreignRepoReason("acme/cloud")}`]);
}

describe("PRIVLOCK2 private card narrowed on its merge-stage foreign_repo escalation", () => {
  test("[验收线 1] on: 12 repo: locks → the PR's 2 files; a rival private card on the rest can then dispatch", async () => {
    const s = await privateAtMerge("on");
    try {
      expect(s.locks()).toEqual([...GLOBS].sort());
      expect(() => dispatchRival(s.f, [`${R}docs/acp.md`])).toThrow(/docs\/acp\.md.*T1/);
      escalatedAsMain(s, await s.f.tick());
      expect(s.locks()).toEqual(NARROWED);
      expect(s.events("merge_private_narrow")).toEqual([expect.objectContaining({ actor: "scheduler", text: "交接后文件锁收窄到 PR 实际改动：12 → 2 把",
        data: expect.objectContaining({ head: H1, repo: "acme/cloud", from: [...GLOBS].sort(), to: NARROWED }) })]);
      expect(s.w.calls.map((c) => c.timeoutMs)).toEqual(s.w.calls.map(() => PRIVATE_READ_MS));
      expect(dispatchRival(s.f, [`${R}docs/acp.md`]).duplicate).toBe(false);
    } finally { s.f.close(); }
  });

  test("[验收线 4] narrowed, then sent back to fix: the fix dispatch takes the full repo: fileGlobs again", async () => {
    const s = await privateAtMerge("on");
    try {
      // the module alone (the card stays auto, as one PM gave back to auto would be): fix rules are the dispatch's, not this card's
      await narrowPrivateMerge({ db: s.f.db, task: s.f.task(), deps: s.f.tickDeps }, ESCALATION);
      expect(s.locks()).toEqual(NARROWED);
      await s.f.cli("pm", "stage", "T1", "--from", "merge", "--to", "fix", "--text", "仓库方要改");
      planIntent(s.f.db, s.f.at("scheduler"), { id: "T1:fix:x", taskId: "T1", taskRev: s.f.task().rev, workflowRev: getWorkflow(s.f.db, "T1")!.rev,
        causalSeq: (s.f.db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq, node: "fix", action: "dispatch",
        recipient: "agent-task-one", reason: "派单", resources: [...GLOBS, "task:T1"] });
      expect(s.locks()).toEqual([...GLOBS, `${R}src/lib/acp/session.ts`].sort());
    } finally { s.f.close(); }
  });

  const refusals: [string, (w: World) => void, RegExp][] = [
    ["no private clone", (w) => { w.dir = null; }, /^项目 dirs 里没有 acme\/cloud 的 clone$/],
    ["clone's origin is another repository", (w) => { w.origin = "git@github.com:acme/other.git"; }, /origin 不是 PR 的仓库/],
    ["gh fails", (w) => { w.gh = fail(1); }, /^gh pr view 失败（exit 1）$/],
    ["gh times out (fake slow command)", (w) => { w.gh = fail(null, true); }, /^gh pr view 超时$/],
    ["git fetch fails", (w) => { w.fetch = fail(128); }, /^git fetch 失败（exit 128）$/],
    ["git fetch times out (fake slow command)", (w) => { w.fetch = fail(null, true); }, /^git fetch 超时$/],
    ["PR not OPEN", (w) => { w.gh = { state: "CLOSED" }; }, /^PR 是 CLOSED，不是 OPEN$/],
    ["base not main", (w) => { w.gh = { baseRefName: "release" }; }, /^PR 的 base 不是 main$/],
    ["PR head is not the card's", (w) => { w.gh = { headRefOid: "9".repeat(40) }; }, /不是台账 head/],
    ["list too long", (w) => { w.diff = `${"x".repeat(600 * 1024)}\0`; }, /太长/],
  ];
  for (const [name, set, why] of refusals) {
    test(`[验收线 2] ${name}: locks unchanged, one classified record without stderr or local path, escalation as main`, async () => {
      const s = await privateAtMerge("on");
      try {
        set(s.w);
        escalatedAsMain(s, await s.f.tick());
        expect(s.locks()).toEqual([...GLOBS].sort());
        const [ev, ...more] = s.events("merge_private_narrow");
        expect(more).toEqual([]);
        expect(String(ev!.data.skipped)).toMatch(why);
        expect(ev!.text).toBe(`交接后文件锁不收窄：${ev!.data.skipped}`);
        expect(JSON.stringify(ev)).not.toMatch(/secret|fatal|\/Users\/|\/fake\//);
      } finally { s.f.close(); }
    });
  }

  test("[验收线 2] a bare lock mixed in, or locks in another repository than the PR's: no read, locks unchanged, recorded", async () => {
    for (const [lock, why] of [["src/x.ts", /裸路径/], ["repo:acme/other/x.ts", /混了 2 个仓库/]] as const) {
      const s = await privateAtMerge("on");
      try {
        const intent = (s.f.db.query("SELECT intentId FROM scheduler_resources WHERE taskId = 'T1' LIMIT 1").get() as { intentId: string }).intentId;
        s.f.db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T1', ?, 1, 'card')").run(lock, intent);
        const before = s.f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' ORDER BY resource").all();
        escalatedAsMain(s, await s.f.tick());
        expect(s.f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' ORDER BY resource").all()).toEqual(before);
        expect(String(s.events("merge_private_narrow")[0]!.data.skipped)).toMatch(why);
        expect(s.w.calls).toEqual([]);
      } finally { s.f.close(); }
    }
  });

  test("[验收线 2] steps that each finish in time but not together: the read stops at the 30 s deadline, locks whole, recorded", async () => {
    // gh 14 s, then config / fetch / diff 10.5 s each (each under its own 15 s): the git share ends 15 s in, the read at 29 s + 15 s
    for (const [delay, why, steps] of [[{ gh: 14_000, config: 10_500, fetch: 10_500, diff: 10_500 }, /^git fetch 超时$/, ["gh", "config", "fetch"]],
      [{ config: 10_500, fetch: 4_000, diff: 10_500 }, /^git diff 超时$/, ["gh", "config", "fetch", "diff"]]] as const) {
      const s = await privateAtMerge("on");
      try {
        s.w.delay = delay;
        const start = s.w.now;
        escalatedAsMain(s, await s.f.tick());
        expect(s.w.now - start).toBeLessThanOrEqual(PRIVATE_READ_BUDGET_MS);
        expect(s.w.calls.map((c) => c.argv[0] === "gh" ? "gh" : c.argv[1])).toEqual([...steps]);
        expect(s.locks()).toEqual([...GLOBS].sort());
        expect(String(s.events("merge_private_narrow")[0]!.data.skipped)).toMatch(why);
      } finally { s.f.close(); }
    }
  });

  test("[验收线 2] the clone lookup counts: gh gets only what is left of the 30 s", async () => {
    const s = await privateAtMerge("on");
    try {
      setPrivateNarrowIoForTest({ repoDir: () => { s.w.now += 29_000; return DIR; }, clock: () => s.w.now,
        command: async (argv, opts) => { s.w.calls.push({ argv, timeoutMs: opts.timeoutMs }); s.w.now += opts.timeoutMs; return fail(null, true); } });
      await s.f.tick();
      expect(s.w.calls.map((c) => c.timeoutMs)).toEqual([1_000]);
      expect(String(s.events("merge_private_narrow")[0]!.data.skipped)).toBe("gh pr view 超时");
    } finally { s.f.close(); }
  });

  test("[验收线 3] observe: an intent opened while the PR was being read → no observation written", async () => {
    const s = await privateAtMerge("observe");
    try {
      s.w.onGh = () => s.f.db.query("UPDATE scheduler_intents SET status = 'submitted' WHERE id = (SELECT MAX(id) FROM scheduler_intents WHERE taskId = 'T1')").run();
      await narrowPrivateMerge({ db: s.f.db, task: s.f.task(), deps: s.f.tickDeps }, ESCALATION);
      expect(s.w.calls.length).toBeGreaterThan(0);
      expect(listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.mechanism === "privateMergeNarrow")).toEqual([]);
      expect(s.locks()).toEqual([...GLOBS].sort());
    } finally { s.f.close(); }
  });

  test("[验收线 3] same head escalated again: no new record, the PR is not read again; an open intent writes and narrows nothing", async () => {
    const s = await privateAtMerge("on");
    try {
      await s.f.tick();
      const reads = s.w.calls.length, card = { db: s.f.db, task: s.f.task(), deps: s.f.tickDeps };
      const plan = ESCALATION;
      await narrowPrivateMerge(card, plan);
      expect(s.w.calls).toHaveLength(reads);
      expect(s.events("merge_private_narrow")).toHaveLength(1);

      const t = await privateAtMerge("on");
      try {
        t.f.db.query("UPDATE scheduler_intents SET status = 'submitted' WHERE id = (SELECT MAX(id) FROM scheduler_intents WHERE taskId = 'T1')").run();
        await narrowPrivateMerge({ db: t.f.db, task: t.f.task(), deps: t.f.tickDeps }, plan);
        expect(t.events("merge_private_narrow")).toEqual([]);
        expect(t.locks()).toEqual([...GLOBS].sort());
        expect(t.w.calls).toEqual([]);
      } finally { t.f.close(); }
    } finally { s.f.close(); }
  });

  test("[验收线 5] off: no read, no record, locks as main", async () => {
    const s = await privateAtMerge("off");
    try {
      escalatedAsMain(s, await s.f.tick());
      expect(s.w.calls).toEqual([]);
      expect(s.events("merge_private_narrow")).toEqual([]);
      expect(s.events("recovery_observe")).toEqual([]);
      expect(s.locks()).toEqual([...GLOBS].sort());
    } finally { s.f.close(); }
  });

  for (const mode of ["observe", null] as const) {
    test(`[验收线 5] ${mode ?? "unconfigured (= observe)"}: one observation, locks unchanged, not recorded twice for the same (card, head)`, async () => {
      const s = await privateAtMerge(mode);
      try {
        escalatedAsMain(s, await s.f.tick());
        expect(s.locks()).toEqual([...GLOBS].sort());
        expect(s.events("merge_private_narrow")).toEqual([]);
        const notes = () => listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.mechanism === "privateMergeNarrow");
        expect(notes()).toEqual([expect.objectContaining({ text: "恢复观察（privateMergeNarrow）：本会 收窄 12 → 2 把",
          data: expect.objectContaining({ head: H1, to: NARROWED, repo: "acme/cloud" }) })]);
        const reads = s.w.calls.length;
        await narrowPrivateMerge({ db: s.f.db, task: s.f.task(), deps: s.f.tickDeps },
          ESCALATION);
        expect(notes()).toHaveLength(1);
        expect(s.w.calls).toHaveLength(reads);
      } finally { s.f.close(); }
    });
  }

  test("[验收线 6] other escalations are not ours: zero reads, zero records", async () => {
    const s = await privateAtMerge("on");
    try {
      const card = { db: s.f.db, task: s.f.task(), deps: s.f.tickDeps };
      await narrowPrivateMerge(card, { kind: "escalate", code: "foreign_repo", reason: "卡在 acme/cloud，本机没有这个仓库的检出；拒审接续……" });
      await narrowPrivateMerge({ ...card, task: { ...card.task, stage: "review" } }, ESCALATION);
      await narrowPrivateMerge({ ...card, task: { ...card.task, extra: { fileGlobs: ["src/a.ts"] } } }, ESCALATION);
      expect(s.w.calls).toEqual([]);
      expect(s.events("merge_private_narrow")).toEqual([]);
    } finally { s.f.close(); }
  });
});

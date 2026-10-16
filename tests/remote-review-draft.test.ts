/**
 * RRL-3: a handoff project's PR is opened as a draft (the owner's queue skips drafts) and turned ready when the card is handed over.
 * The exec prompt asks for a draft only on mergeHandoff projects (our own merge train cannot merge a draft); ghPrState turns a
 * followed draft ready, and driveHandoff reads it once more right after the handoff so that happens in the same pass.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderExecPrompt, type PromptVars } from "../src/lib/dag-tools-prompt.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { startIo } from "../src/lib/scheduler-autostart-deps.js";
import { localAuthorPlan } from "../src/lib/scheduler-local-author-plan.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ghPrState, HANDOFF_POLL_MS, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";
const V: PromptVars = { task: "T1", title: "t", pm: "agent-pm", branch: "feat/t1", base: "origin/main", worktree: "/wt", spec: "/s.md", ledgerDir: "/l" };
const deliverLine = (out: string) => out.split("\n").find((l) => l.startsWith("- 「开工 / 修复」单"))!;

describe("exec prompt: draft only on handoff projects", () => {
  test("mergeHandoff asks for a draft PR, keeps the rest of the PR line, and says the scheduler turns it ready", () => {
    const line = deliverLine(renderExecPrompt({ ...V, mergeHandoff: true }));
    for (const s of ["`gh pr create --draft`", "开好 PR", "base main", "已开过的不用重开", "转 ready", "deliver 工具", "没开 PR 会被拒", "--pr <完整 PR 链接>"]) {
      expect(line).toContain(s);
    }
  });

  test("other PR projects are word for word as before; localMerge wins (no PR at all)", () => {
    expect(renderExecPrompt({ ...V, mergeHandoff: false })).toBe(renderExecPrompt(V));
    expect(renderExecPrompt(V)).not.toContain("--draft");
    const local = renderExecPrompt({ ...V, localMerge: true, mergeHandoff: true });
    expect(local).toBe(renderExecPrompt({ ...V, localMerge: true }));
    expect(local).not.toContain("--draft");
  });

  test("the scheduler's start env reads mergeHandoff from scheduler.json", () => {
    const env = (handoff: boolean) => startIo({ db: null, ledger: async () => ({ ok: true }), active: () => {}, lease: undefined } as never,
      parseSchedulerConfig({ enabled: true, autoDispatch: true,
        projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/repo", ...(handoff ? { mergeHandoff: true } : {}) } } })).startEnv();
    expect(env(true).mergeHandoff?.("p")).toBe(true);
    expect(env(false).mergeHandoff?.("p")).toBe(false);
    expect(env(true).mergeHandoff?.("__proto__")).toBe(false);
  });
});

/** A fake `gh`: `pr view` answers `view`, `pr ready` answers `ready`; every argv is kept. */
function gh(view: Record<string, unknown>, ready: { code: number; stderr?: string } = { code: 0 }) {
  const calls: string[][] = [];
  const command = (async (argv: string[]) => {
    calls.push(argv);
    if (argv[2] === "ready") return { code: ready.code, stdout: "", stderr: ready.stderr ?? "", timedOut: false };
    return { code: 0, stdout: JSON.stringify(view), stderr: "", timedOut: false };
  }) as unknown as typeof runBounded;
  return { command, readies: () => calls.filter((a) => a[2] === "ready") };
}
const open = (head: string, isDraft: boolean) => ({ state: "OPEN", headRefOid: head, mergeCommit: null, baseRefName: "main", isDraft });
const none = () => null;

describe("ghPrState: a followed draft is turned ready", () => {
  test("open draft at the followed head → gh pr ready on that PR, read back as not a draft", async () => {
    const g = gh(open(H1, true));
    expect(await ghPrState(g.command, none, none, none)(PR, { project: "p", head: H1 })).toMatchObject({ state: "OPEN", head: H1, draft: false });
    expect(g.readies()).toEqual([["gh", "pr", "ready", PR]]);
  });

  test("a refused ready never throws: the read goes on with the reason, still a draft", async () => {
    const g = gh(open(H1, true), { code: 1, stderr: "GraphQL: rate limited\nmore" });
    const r = await ghPrState(g.command, none, none, none)(PR, { project: "p", head: H1 });
    expect(r).toMatchObject({ state: "OPEN", draft: true, flipError: "gh pr ready 失败：GraphQL: rate limited" });
  });

  test("before the handoff, off the followed head, not a draft, or not open: no ready", async () => {
    const cases: [Record<string, unknown>, { project: string; head: string } | undefined][] = [
      [open(H1, true), undefined],
      [open(H2, true), { project: "p", head: H1 }],
      [open(H1, false), { project: "p", head: H1 }],
      [{ ...open(H1, true), state: "CLOSED" }, { project: "p", head: H1 }],
    ];
    for (const [view, follow] of cases) {
      const g = gh(view);
      const r = await ghPrState(g.command, none, none, none)(PR, follow);
      expect(g.readies()).toEqual([]);
      expect(r.flipError).toBeUndefined();
    }
    const g = gh(open(H1, true));
    expect((await ghPrState(g.command, none, none, none)(PR)).draft).toBe(true); // isDraft is read
  });
});

type F = ReturnType<typeof autoFixture>;
async function toMerge(f: F) {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  await f.tick();
  expect(f.task().stage).toBe("merge");
}

/** The handoff tick with a recording prState: each read's `follow` head (undefined = not handed over yet). */
function hand(f: F, answer: (follow?: { head: string }) => HandoffPr) {
  const reads: (string | undefined)[] = [];
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps,
      prState: async (_pr, follow) => { reads.push(follow?.head); return answer(follow); } });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  return { tick, reads };
}
const handoffs = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "merge_handoff");

describe("driveHandoff: ready in the handoff pass", () => {
  test("a draft is read once more as handed over right after the handoff record", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const h = hand(f, (follow) => ({ state: "OPEN", head: H1, mergeSha: null, ...(follow ? { draft: false } : { draft: true }) }));
      const out = await h.tick();
      expect(out).toMatchObject({ step: "handoff" });
      expect(out.detail).not.toContain("ready");
      expect(h.reads).toEqual([undefined, H1]);
      expect(handoffs(f)).toHaveLength(1);
    } finally { f.close(); }
  });

  test("a refused ready keeps the handoff and says so; the next poll reads it as handed over again", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const h = hand(f, (follow) => ({ state: "OPEN", head: H1, mergeSha: null, draft: true, ...(follow ? { flipError: "gh pr ready 失败：x" } : {}) }));
      const out = await h.tick();
      expect(out).toMatchObject({ step: "handoff" });
      expect(out.detail).toContain("草稿没转成 ready，下轮再试：gh pr ready 失败：x");
      expect(handoffs(f)).toHaveLength(1);
      expect(f.task().stage).toBe("merge");
      f.advance(HANDOFF_POLL_MS);
      const next = await h.tick();
      expect(next).toMatchObject({ step: "waiting" });
      expect(next.detail).toContain("草稿没转成 ready");
      expect(h.reads).toEqual([undefined, H1, H1]);
    } finally { f.close(); }
  });

  test("a PR that is not a draft is read once, as before", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const h = hand(f, () => ({ state: "OPEN", head: H1, mergeSha: null }));
      expect(await h.tick()).toMatchObject({ step: "handoff" });
      expect(h.reads).toEqual([undefined]);
    } finally { f.close(); }
  });

  test("a read that throws after the handoff record only delays the ready", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const h = hand(f, (follow) => { if (follow) throw new Error("gh pr view 失败：boom"); return { state: "OPEN", head: H1, mergeSha: null, draft: true }; });
      const out = await h.tick();
      expect(out).toMatchObject({ step: "handoff" });
      expect(out.detail).toContain("草稿转 ready 前读 PR 失败，下轮再试");
      expect(handoffs(f)).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("the scheduler's rebuild path renders the draft line too", () => {
  test("localAuthorPlan on a mergeHandoff project: draft PR; on a plain PR project: as before", async () => {
    const f = autoFixture(), repo = join(f.dir, "repo");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(f.dir, "T1.md"), "# 规格\n");
      f.db.query("UPDATE tasks SET branch = 'feat/t1', spec = ? WHERE id = 'T1'").run(join(f.dir, "T1.md"));
      const plan = async (handoff: boolean) => {
        const configPath = join(f.dir, "scheduler.json"), projectsPath = join(f.dir, "projects.json");
        writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true,
          projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: repo, ...(handoff ? { mergeHandoff: true } : {}) } } }));
        writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));
        const r = await localAuthorPlan(f.db, f.task(), join(f.dir, "wt"), { configPath, projectsPath } as never);
        if (typeof r === "string") throw new Error(r);
        return r.promptText;
      };
      expect(deliverLine(await plan(true))).toContain("`gh pr create --draft`");
      expect(await plan(false)).not.toContain("--draft");
    } finally { f.close(); }
  });
});

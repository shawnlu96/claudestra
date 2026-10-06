/**
 * LCK-1 at the merge handoff: the card's file locks shrink to the PR's own files when handed over, go away as soon as the merged
 * PR moves it to live, and come back in full when it is sent back to fix. Stranded locks of already-live cards are swept per tick.
 */
import { describe, expect, test } from "bun:test";
import { reconcileFinishedCardLeases } from "../src/lib/ledger-scheduler-lease-finished.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { ghPrState, handoffFiles, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { HANDOFF_POLL_MS } from "../src/lib/scheduler-merge-handoff-tick.js";
import { narrowHandoffLocks } from "../src/lib/scheduler-merge-handoff-narrow.js";
import { autoFixture, H1, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";
const M = "a".repeat(40);
/** ACPB-1's shape: twelve declared globs, a PR that touched two of them (and one file outside them). */
const GLOBS = ["src/lib/acp/*", "src/bridge/acp-link.ts", "src/lib/acp-turn.ts", "src/lib/acp-host.ts", "src/lib/acp-ports.ts", "src/lib/acp-env.ts",
  "src/lib/acp-pool.ts", "src/lib/acp-log.ts", "tests/acp-*.test.ts", "docs/acp.md", "src/lib/acp-relay.ts", "src/lib/acp-codec.ts"];
const PR_FILES = ["src/lib/acp/session.ts", "src/bridge/acp-link.ts", "README.md"];

async function narrowFixture(files: string[] | null = PR_FILES) {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: GLOBS }));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  let pr: HandoffPr = { state: "OPEN", head: H1, mergeSha: null };
  const hand = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps,
      prState: async (_ref, _follow, handing) => (handing ? { ...pr, files } : pr) });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const locks = (taskId = "T1") => (f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? AND scope = 'card' AND resource NOT LIKE '%:%' ORDER BY resource")
    .all(taskId) as { resource: string }[]).map((r) => r.resource);
  return { f, hand, locks, setPr: (p: HandoffPr) => { pr = p; } };
}

/**
 * planIntent is where the scheduler refuses an overlapping lock. `taskId` plans one dispatch with `resources`; a card other than T1
 * is auto only for that call, so the fixture's ticks never try to run it.
 */
function dispatch(f: ReturnType<typeof autoFixture>, taskId: string, node: string, resources: string[]) {
  const flip = (mode: "auto" | "manual") => setWorkflow(f.db, f.at("owner"), { taskId, taskRev: getTask(f.db, taskId)!.rev,
    workflowRev: getWorkflow(f.db, taskId)?.rev, template: "code", templateVersion: 2,
    mode, authorFamily: "claude", fallback: "x", ...(mode === "manual" ? { reason: "pm_hold: 测试里只派这一单" } : {}) });
  if (taskId !== "T1") flip("auto");
  try {
    const seq = (f.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
    return planIntent(f.db, f.at("scheduler"), { id: `${taskId}:${node}:${seq}`, taskId, taskRev: getTask(f.db, taskId)!.rev,
      workflowRev: getWorkflow(f.db, taskId)!.rev, causalSeq: seq, node, action: "dispatch", recipient: getTask(f.db, taskId)!.agent ?? "w", reason: "派单", resources });
  } finally { if (taskId !== "T1") flip("manual"); }
}

describe("LCK-1 file locks at the merge handoff", () => {
  test("handoff keeps only PR ∩ fileGlobs (12 → 2); MERGED → live frees them at once and the rival card can dispatch", async () => {
    const { f, hand, locks, setPr } = await narrowFixture();
    try {
      expect(locks()).toEqual([...GLOBS].sort());
      expect(await hand()).toMatchObject({ step: "handoff", detail: expect.stringContaining("文件锁收窄 12 → 2") });
      expect(locks()).toEqual(["src/bridge/acp-link.ts", "src/lib/acp/session.ts"]);
      const ev = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.data.op === "merge_handoff_narrow")!;
      expect(ev).toMatchObject({ actor: "scheduler", data: { from: [...GLOBS].sort(), to: ["src/bridge/acp-link.ts", "src/lib/acp/session.ts"] } });
      expect(narrowHandoffLocks(f.db, { actor: "scheduler" }, { taskId: "T1", head: H1, pr: PR, files: ["docs/acp.md"] })).toMatchObject({ duplicate: true });
      expect(locks()).toEqual(["src/bridge/acp-link.ts", "src/lib/acp/session.ts"]);

      createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "rival", kind: "code", agent: "agent-task-two", extra: { fileGlobs: ["src/bridge/acp-link.ts"] } });
      const plan = () => dispatch(f, "T2", "restate", ["src/bridge/acp-link.ts", "task:T2"]);
      expect(plan).toThrow(/src\/bridge\/acp-link\.ts.*T1/);
      setPr({ state: "MERGED", head: H1, mergeSha: M });
      f.advance(HANDOFF_POLL_MS);
      expect(await hand()).toMatchObject({ step: "landed" });
      expect(f.task().stage).toBe("live");
      expect(f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' AND scope = 'card'").all()).toEqual([]);
      expect(plan().duplicate).toBe(false);
    } finally { f.close(); }
  });

  test("sent back to fix after the handoff, the fix dispatch takes the full declared scope again", async () => {
    const { f, hand, locks } = await narrowFixture();
    try {
      await hand();
      expect(locks()).toHaveLength(2);
      await f.cli("pm", "stage", "T1", "--from", "merge", "--to", "fix", "--text", "仓库方要改");
      dispatch(f, "T1", "fix", [...GLOBS, "task:T1"]); // the planner dispatches a fix with the card's fileGlobs (scheduler-plan.ts fileResources)
      expect(locks()).toEqual([...GLOBS, "src/lib/acp/session.ts"].sort());
    } finally { f.close(); }
  });

  test("files the scheduler cannot name, or no file list at all, leave the locks whole", async () => {
    for (const files of [["src/lib/acp/中文.ts"], null]) {
      const { f, hand, locks } = await narrowFixture(files);
      try {
        expect(await hand()).toMatchObject({ step: "handoff" });
        expect(locks()).toEqual([...GLOBS].sort());
      } finally { f.close(); }
    }
  });

  test("a card already live with stranded locks and no open intent is released by the next tick's sweep", async () => {
    const { f, locks } = await narrowFixture();
    try {
      f.db.query("UPDATE tasks SET stage = 'live' WHERE id = 'T1'").run(); // the pre-LCK-1 handoff landing left them
      expect(locks()).toHaveLength(12);
      await reconcileFinishedCardLeases(f.db, ["p"], () => {});
      expect(locks()).toEqual([]);
    } finally { f.close(); }
  });

  test("the PR's files come from the clone's three-dot diff, renames as both sides; a foreign origin or failing git gives none", async () => {
    const calls: string[][] = [];
    const git = (origin: string, diffCode = 0) => async (argv: string[]) => {
      calls.push(argv);
      const out = argv[1] === "config" ? `${origin}\n` : argv[1] === "diff" ? "src/a.ts\0src/old.ts\0src/new.ts\0" : "";
      return { code: argv[1] === "diff" ? diffCode : 0, stdout: out, stderr: "boom", timedOut: false };
    };
    expect(await handoffFiles("/repo", git("git@github.com:example/repo.git"))(PR, H1)).toEqual(["src/a.ts", "src/old.ts", "src/new.ts"]);
    expect(calls.at(-1)).toEqual(["git", "diff", "--name-only", "--no-renames", "-z", `refs/remotes/origin/main...${H1}`]);
    expect(await handoffFiles("/repo", git("https://github.com/other/repo"))(PR, H1)).toBeNull();
    const cut = async (argv: string[]) => ({ code: 0, stdout: argv[1] === "config" ? "git@github.com:example/repo.git" : argv[1] === "diff" ? "src/a.ts\0src/b" : "",
      stderr: "", timedOut: false });
    expect(await handoffFiles("/repo", cut)(PR, H1)).toBeNull();
    const view = async () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: H1, mergeCommit: null }), stderr: "", timedOut: false });
    const read = ghPrState(view, () => null, () => handoffFiles("/repo", git("git@github.com:example/repo.git", 1)));
    expect(await read(PR, undefined, { project: "p" })).toEqual({ state: "OPEN", head: H1, mergeSha: null, files: null });
    expect(await read(PR)).toEqual({ state: "OPEN", head: H1, mergeSha: null });
  });
});

/**
 * HBASE1 (audit a03 A03-01): the merge handoff lands a card only on real evidence that its PR went into main. The tick runs the
 * real driveHandoff on a fake gh / git port: the PR's base is read with it, a PR retargeted off main stops at PM (OPEN or MERGED),
 * and a MERGED PR goes live only once the configured clone's main holds the merge commit; anything unreadable is held. The final
 * writer rechecks the proof the tick passes (base main, the PR head the handoff follows) and refuses a landing without one: a
 * ReadPr that leaves the landing out, or the scheduler CLI's `--merged` (which reads neither the PR nor main), never goes live.
 * The legal main carry still lands.
 */
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { MainMergeCarry } from "../src/lib/scheduler-main-merge-carry.js";
import { ghPrState, handoffOnMain, HANDOFF_POLL_MS, type HandoffCarry, type ReadPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { landMergeHandoff } from "../src/lib/scheduler-merge-handoff.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";
const M = "a".repeat(40), MP = "b".repeat(40), MH = "c".repeat(40), MAIN = "e".repeat(40), HASH = "d".repeat(64);
const GLOBS = ["src/lib/x.ts", "tests/x.test.ts"];
const pure: MainMergeCarry = { ok: true, reason: "净 diff 一致", mainParent: MP, mainHead: MH, diffHash: HASH, basis: "net-diff" };

/** What GitHub and the project's clone answer this round; `ancestor` is git merge-base --is-ancestor's exit code. */
interface World { state: string; head: string; merge: string | null; base?: string; ancestor: number; noRepoDir?: boolean }

/** The card handed over at H1 through the real ghPrState → driveHandoff, with gh and git played by a fake command. */
async function handedOver() {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: GLOBS }));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  let w: World = { state: "OPEN", head: H1, merge: null, base: "main", ancestor: 1 };
  const calls: string[][] = [];
  const command: typeof runBounded = async (argv) => {
    calls.push(argv);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (argv[0] === "gh") {
      return ok(JSON.stringify({ state: w.state, headRefOid: w.head, mergeCommit: w.merge ? { oid: w.merge } : null, ...(w.base === undefined ? {} : { baseRefName: w.base }) }));
    }
    if (argv[1] === "config") return ok("git@github.com:example/repo.git\n");
    if (argv[1] === "rev-parse") return ok(`${MAIN}\n`);
    if (argv[1] === "merge-base") return { code: w.ancestor, stdout: "", stderr: w.ancestor > 1 ? "fatal: bad object" : "", timedOut: false };
    return ok("");
  };
  const carry: HandoffCarry = async (_pr, oldHead) => (oldHead === H1 ? pure : { ok: false, reason: "没跟这个 head" });
  const read = ghPrState(command, () => carry, () => null, () => (w.noRepoDir ? null : handoffOnMain("/repo", command)));
  const pass = async (prState: ReadPr = read) => {
    f.advance(HANDOFF_POLL_MS);
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, prState });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const lives = () => events().filter((e) => e.kind === "stage" && e.data.to === "live");
  const locks = () => (f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' AND scope = 'card' AND resource NOT LIKE '%:%' ORDER BY resource")
    .all() as { resource: string }[]).map((r) => r.resource);
  const landedNotices = () => f.notices.filter((n) => n.includes("已由仓库方合并"));
  return { f, pass, calls, events, lives, locks, landedNotices, set: (x: Partial<World>) => { w = { ...w, ...x }; } };
}

describe("HBASE1 merge handoff lands only on main", () => {
  test("[验收线 1] a PR merged into another branch (main lacking the merge) never lands: PM, no live, locks kept", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      expect(h.calls.find((a) => a[0] === "gh")).toContain("state,headRefOid,mergeCommit,baseRefName,isDraft");
      const held = h.locks();
      expect(held).toEqual(GLOBS);
      h.set({ state: "MERGED", head: H1, merge: M, base: "release", ancestor: 1 });
      expect(await h.pass()).toMatchObject({ step: "manual", detail: expect.stringContaining("改投到 release") });
      expect(f.task().stage).toBe("merge");
      expect(h.lives()).toEqual([]);
      expect(h.landedNotices()).toEqual([]);
      expect(h.locks()).toEqual(held);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(h.calls.some((a) => a[1] === "merge-base")).toBe(false); // retargeted: no git read vouches for it
    } finally { f.close(); }
  });

  test("[验收线 1] a PR retargeted off main while open stops at PM; one off main at handoff is never handed over", async () => {
    const h = await handedOver(), { f } = h;
    try {
      h.set({ base: "develop" });
      expect(await h.pass()).toMatchObject({ step: "manual", detail: expect.stringContaining("develop") });
      expect(h.events().filter((e) => e.data.op === "merge_handoff")).toEqual([]);
      expect(h.locks()).toEqual(GLOBS);
    } finally { f.close(); }
    const g = await handedOver();
    try {
      expect(await g.pass()).toMatchObject({ step: "handoff" });
      g.set({ base: "develop" });
      expect(await g.pass()).toMatchObject({ step: "manual", detail: expect.stringContaining("OPEN") });
      expect(g.f.task().stage).toBe("merge");
      expect(g.locks()).toEqual(GLOBS);
    } finally { g.f.close(); }
  });

  test("[验收线 2] merged into main but main lacks the merge commit, the check fails, base is unread or no repoDir → held", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      const rounds: [Partial<World>, string][] = [
        [{ state: "MERGED", merge: M, base: "main", ancestor: 1 }, "还不含合并提交"],
        [{ ancestor: 128 }, "git merge-base 失败"],
        [{ ancestor: 0, base: undefined }, "读不出 PR 合进的分支"],
        [{ base: "main", noRepoDir: true }, "没配 repoDir"],
      ];
      for (const [world, why] of rounds) {
        h.set(world);
        expect(await h.pass()).toMatchObject({ step: "held", detail: expect.stringContaining(why) });
        expect(f.task().stage).toBe("merge");
        expect(h.lives()).toEqual([]);
        expect(h.locks()).toEqual(GLOBS);
      }
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("[验收线 2] merged into main and on it → live and locks freed exactly once, with the main that holds it", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      h.set({ state: "MERGED", merge: M, base: "main", ancestor: 0 });
      expect(await h.pass()).toMatchObject({ step: "landed" });
      expect(f.task().stage).toBe("live");
      expect(h.lives()).toHaveLength(1);
      expect(h.lives()[0]!.data).toMatchObject({ head: H1, mergeSha: M, base: "main", mainHead: MAIN });
      expect(h.locks()).toEqual([]);
      expect(await h.pass()).not.toMatchObject({ step: "landed" });
      expect(h.lives()).toHaveLength(1);
      expect(h.landedNotices()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("[验收线 2] the legal main carry after the handoff still lands at the carried head", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      h.set({ state: "OPEN", head: H2 });
      expect(await h.pass()).toMatchObject({ step: "waiting", detail: expect.stringContaining("PR 只合入了 main") });
      h.set({ state: "MERGED", head: H2, merge: M, ancestor: 0 });
      expect(await h.pass()).toMatchObject({ step: "landed" });
      expect(h.lives()).toHaveLength(1);
      expect(h.lives()[0]!.data).toMatchObject({ head: H2, handedHead: H1, mergeSha: M, base: "main", mainHead: MAIN });
    } finally { f.close(); }
  });

  test("[验收线 2] the writer rechecks the proof: a base other than main or a head the handoff does not follow is refused", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      const land = (proof: { base: string; prHead: string; mainHead: string }) => () =>
        landMergeHandoff(f.db, { actor: "scheduler" }, { taskId: "T1", head: H1, pr: PR, mergeSha: M, proof });
      expect(land({ base: "release", prHead: H1, mainHead: MAIN })).toThrow("交接只认合进 main");
      expect(land({ base: "main", prHead: H2, mainHead: MAIN })).toThrow("不是交接后跟的");
      expect(land({ base: "main", prHead: H1, mainHead: "short" })).toThrow("完整 SHA");
      expect(f.task().stage).toBe("merge");
      expect(h.locks()).toEqual(GLOBS);
      expect(land({ base: "main", prHead: H1, mainHead: MAIN })().stage).toBe("live");
    } finally { f.close(); }
  });

  test("[验收线 2] a MERGED read into main that leaves the landing out is held: no live, no notice, locks kept", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      const unchecked: ReadPr = async () => ({ state: "MERGED", head: H1, mergeSha: M, base: "main" });
      expect(await h.pass(unchecked)).toMatchObject({ step: "held", detail: expect.stringContaining("没证实进了 main") });
      expect(f.task().stage).toBe("merge");
      expect(h.lives()).toEqual([]);
      expect(h.landedNotices()).toEqual([]);
      expect(h.locks()).toEqual(GLOBS);
      h.set({ state: "MERGED", merge: M, base: "main", ancestor: 0 });
      expect(await h.pass()).toMatchObject({ step: "landed" }); // the checked read still lands, once
      expect(h.lives()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("[验收线 2] the writer refuses a landing without checked proof: the CLI's --merged and a direct write stay in merge", async () => {
    const h = await handedOver(), { f } = h;
    try {
      expect(await h.pass()).toMatchObject({ step: "handoff" });
      expect(await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--merged", M))
        .toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("没有核对过的合入证据") });
      expect(await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--merged", M, "--base", "main", "--pr-head", H1))
        .toMatchObject({ ok: false, code: "invalid" }); // part of the proof is no proof
      expect(await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--merged", M, "--base", "release", "--pr-head", H1,
        "--main-head", MAIN)).toMatchObject({ ok: false, code: "conflict" }); // the CLI's proof is rechecked like the tick's
      expect(() => landMergeHandoff(f.db, { actor: "scheduler" }, { taskId: "T1", head: H1, pr: PR, mergeSha: M })).toThrow("没有核对过的合入证据");
      expect(f.task().stage).toBe("merge");
      expect(h.lives()).toEqual([]);
      expect(h.locks()).toEqual(GLOBS);
    } finally { f.close(); }
  });
});

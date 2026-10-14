/**
 * KEYSORT1 · the merge queue's union merge refuses a result that leaves recovery-keys.ts out of order, on real repositories (a
 * bare "origin" and a clone as repoDir, as in scheduler-merge-union-git.test.ts). Same gap with the PR's key sorting after
 * main's: refused, observe notes "仍退回 fix", on bounces as a conflict, nothing pushed. Same gap with the PR's key first: in
 * order, pushed as before. A PR on the old unsorted table appending at the end against a sorted main: refused, nothing pushed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { pushUnionMerge, trialUnionMerge } from "../src/lib/scheduler-merge-union-git.js";
import { useMergeUnionPorts, type UnionNote } from "../src/lib/scheduler-merge-union.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const KEYS = "src/lib/recovery-keys.ts";
const ATTRS = `${KEYS} merge=union\n`;
const table = (keys: readonly string[]) => `/** keys */\nexport const RECOVERY_KEYS = [\n${keys.map((k) => `  "${k}",\n`).join("")}] as const;\n`;
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const ORDER = /^src\/lib\/recovery-keys\.ts union 结果(?:不按字母序|有重复键)：/;

/** A bare origin and a clone (origin named as a GitHub URL), with the scheduler's git redirected to the bare repo. */
function fixture(prefix: string) {
  let root = "", bare = "", work = "";
  const sh = async (cwd: string, ...args: string[]) => {
    const r = await runBounded(["git", ...IDENTITY, ...args], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  const git = (...args: string[]) => sh(work, ...args);
  const command: typeof runBounded = async (argv, opts) => {
    if (argv[0] !== "git") throw new Error("only git");
    const args = argv.slice(1);
    const remote = ["fetch", "ls-remote", "push"].some((c) => args.includes(c)) ? args.map((a) => (a === "origin" ? bare : a)) : args;
    return runBounded(["git", ...IDENTITY, ...remote], opts);
  };
  const file = (path: string, text: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), text); };
  const commit = async (msg: string) => { await git("add", "-A"); await git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const f = {
    get work() { return work; },
    git, file, commit, command,
    async init() {
      root = mkdtempSync(join(tmpdir(), prefix)); bare = join(root, "origin.git"); work = join(root, "repo");
      mkdirSync(bare); mkdirSync(work);
      await sh(bare, "init", "-q", "--bare", "-b", "main");
      await sh(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
      await git("init", "-q", "-b", "main");
      await git("remote", "add", "origin", "https://github.com/example/union.git");
    },
    cleanup() { if (root) rmSync(root, { recursive: true, force: true }); },
    pushMain: () => sh(work, "push", "-q", bare, "main:refs/heads/main"),
    /** A PR branch named `name` from `from` with the key table replaced, pushed to origin. */
    async pr(name: string, from: string, keys: readonly string[]) {
      await git("checkout", "-q", "--detach", from); file(KEYS, table(keys));
      const head = await commit(`pr ${name}`);
      await sh(work, "push", "-q", bare, `${head}:refs/heads/${name}`);
      await git("checkout", "-q", "main");
      return head;
    },
    remoteHead: (branch: string) => sh(bare, "rev-parse", `refs/heads/${branch}`),
    trial: (branch: string, head: string) => trialUnionMerge({ repoDir: work, repository: "example/union", branch, reviewedHead: head }, command),
  };
  return f;
}

describe("KEYSORT1 same-gap union results (real git)", () => {
  const fx = fixture("merge-union-order-");
  let base = "", mainHead = "";
  // base: audit, zeta; main inserts beta into that gap; PRs insert into the same gap
  beforeAll(async () => {
    await fx.init();
    fx.file(KEYS, table(["askReminder", "audit", "zeta"])); fx.file(".gitattributes", ATTRS);
    base = await fx.commit("base");
    fx.file(KEYS, table(["askReminder", "audit", "beta", "zeta"]));
    mainHead = await fx.commit("main inserts beta");
    await fx.pushMain();
  });
  afterAll(() => fx.cleanup());

  test("[验收线 1] the PR's key sorts after main's: the trial is refused as out of order, nothing pushed", async () => {
    const head = await fx.pr("after", base, ["askReminder", "audit", "gamma", "zeta"]);
    const r = await fx.trial("after", head);
    expect(r).toMatchObject({ ok: false, reason: "src/lib/recovery-keys.ts union 结果不按字母序：gamma 在 beta 前", mainHead, files: [KEYS] });
    expect(await fx.remoteHead("after")).toBe(head);
  });

  test("[验收线 2] the PR's key sorts first: the union result is in order, trial ok and pushed as before", async () => {
    const head = await fx.pr("first", base, ["askReminder", "audit", "axe", "zeta"]);
    const r = await fx.trial("first", head);
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ ok: true, mainHead, files: [KEYS] });
    expect(await fx.git("show", `${r.mergeSha}:${KEYS}`)).toBe(table(["askReminder", "audit", "axe", "beta", "zeta"]).trim());
    expect(await pushUnionMerge({ repoDir: fx.work, branch: "first", reviewedHead: head, mergeSha: r.mergeSha }, fx.command)).toEqual({ ok: true });
    expect(await fx.remoteHead("first")).toBe(r.mergeSha);
  });

  describe("through the merge driver (real git ports)", () => {
    const notes: UnionNote[] = [];
    beforeEach(() => { notes.length = 0; });
    const drive = async (mode: "on" | "observe", branch: string, head: string) => {
      const steps: { to: string; receipt?: string }[] = [];
      let run = { intentId: "i", taskId: "t", project: "p", prRef: "https://github.com/example/union/pull/7", expectedBranch: branch,
        reviewedHead: head, requiredChecks: "test", phase: "ready", rev: 1, mergeSha: null, reason: null, unknownSince: null } as unknown as MergeRun;
      const snapshot: PrSnapshot = { state: "OPEN", head, branch, crossRepository: false, base: "main", draft: false, mergeState: "DIRTY",
        mergeSha: null, checks: [] };
      const external: MergeExternal = { inspect: async () => snapshot, freshness: async () => ({ behindBy: 1, mainHead }),
        carryReview: async () => ({ ok: false, reason: "not here" }), updateBranch: async () => { throw new Error("no update-branch"); },
        merge: async () => { throw new Error("no merge"); }, direct: () => true, unknownRereadMs: 0 };
      using _ports = useMergeUnionPorts({ mode: () => mode, repoDir: () => fx.work,
        trial: (i) => trialUnionMerge(i, fx.command), push: (i) => pushUnionMerge(i, fx.command), note: async (n) => { notes.push(n); } });
      await driveMerge(run, external, async (_f, to, _r, receipt) => { steps.push({ to, receipt }); run = { ...run, phase: to, rev: run.rev + 1 }; return run; });
      return steps;
    };
    const bounce = (head: string) => [{ to: "resolved", receipt: `退回 fix（conflict）：PR head ${head}，main head ${mainHead}` }];
    const why = "src/lib/recovery-keys.ts union 结果不按字母序：gamma 在 beta 前";

    test("[验收线 1] mergeUnion=on: the original conflict bounce, a failure note, nothing pushed", async () => {
      const head = await fx.pr("drive-on", base, ["askReminder", "audit", "gamma", "zeta"]);
      expect(await drive("on", "drive-on", head)).toEqual(bounce(head));
      expect(notes.map((n) => n.action)).toEqual([`本地 union 解冲突没成：${why}`]);
      expect(await fx.remoteHead("drive-on")).toBe(head);
    });

    test("[验收线 1] mergeUnion=observe: a would-not note \"仍退回 fix\", the original bounce, nothing pushed", async () => {
      const head = await fx.pr("drive-observe", base, ["askReminder", "audit", "gamma", "zeta"]);
      expect(await drive("observe", "drive-observe", head)).toEqual(bounce(head));
      expect(notes.map((n) => [n.actionKey.split(".")[0], n.action])).toEqual([["wouldnot", `仍退回 fix：本地 union 解不了（${why}）`]]);
      expect(await fx.remoteHead("drive-observe")).toBe(head);
    });

    test("[验收线 2] mergeUnion=on, the PR's key first: pushed and claimed updating as before", async () => {
      const head = await fx.pr("drive-first", base, ["askReminder", "audit", "axle", "zeta"]);
      expect((await drive("on", "drive-first", head)).map((s) => s.to)).toEqual(["updating"]);
      expect(await fx.git("rev-list", "--parents", "-n", "1", await fx.remoteHead("drive-first"))).toEndWith(`${head} ${mainHead}`);
      expect(notes).toEqual([]);
    });
  });
});

describe("[验收线 3] migration shape: main is sorted, the PR is on the old table with its key appended at the end", () => {
  const fx = fixture("merge-union-migrate-");
  // the old table: the keys sorted except the 12 appended after the move, which sit at the end in their appended order
  const LATE = ["mergeUnion", "writeLocalEqual", "effCountRefresh", "wakeStopped", "lendUsageReport", "lendUiUpload", "convergenceStall",
    "mergePipe", "effCountCarry", "ciLogPerJob", "mergeUnifiedCandidates", "privateStartPlacement"];
  const OLD = [...RECOVERY_KEYS.filter((k) => !LATE.includes(k)), ...LATE];
  let oldBase = "";
  beforeAll(async () => {
    await fx.init();
    fx.file(KEYS, table(OLD)); fx.file(".gitattributes", ATTRS);
    oldBase = await fx.commit("old table");
    fx.file(KEYS, table([...RECOVERY_KEYS]));
    await fx.commit("main sorts the table");
    await fx.pushMain();
  });
  afterAll(() => fx.cleanup());

  test("the trial is refused (duplicate / out of order, or CARRY2) and nothing is pushed", async () => {
    expect(LATE.every((k) => (RECOVERY_KEYS as readonly string[]).includes(k))).toBe(true);
    const head = await fx.pr("migrate", oldBase, [...OLD, "newCardKey"]);
    const r = await fx.trial("migrate", head);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(new RegExp(`${ORDER.source}|^沿用证明不成立：`));
    expect(await fx.remoteHead("migrate")).toBe(head);
  });
});

/**
 * KEYUNION1 git side, on real repositories: a bare "origin" and a clone as the scheduler's repoDir (origin named as a GitHub
 * URL so the repository check holds; fetch / ls-remote / push are pointed at the bare path). A PR that conflicts with main only
 * in the union key file is merged in a scratch worktree and pushed fast-forward; a conflict in any other file, a merge the
 * carry proof would refuse, a DIRTY that is not a union conflict and a branch that moved since review are all refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { pushUnionMerge, trialUnionMerge, unionPaths } from "../src/lib/scheduler-merge-union-git.js";
import { useMergeUnionPorts, type UnionNote } from "../src/lib/scheduler-merge-union.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const KEYS = "src/lib/recovery-keys.ts";
const ATTRS = `${KEYS} merge=union\n`;
const table = (...keys: string[]) => `/** keys */\nexport const RECOVERY_KEYS = [\n${["askReminder", "audit", ...keys].map((k) => `  "${k}",\n`).join("")}] as const;\n`;
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

describe("KEYUNION1 local union merge (real git)", () => {
  let root = "", bare = "", work = "", base = "", preAttrs = "", mainHead = "";
  const sh = async (cwd: string, ...args: string[]) => {
    const r = await runBounded(["git", ...IDENTITY, ...args], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  const git = (...args: string[]) => sh(work, ...args);
  /** The scheduler's commands, with the remote redirected to the bare repo and a fixed identity for the merge commit. */
  const command: typeof runBounded = async (argv, opts) => {
    if (argv[0] !== "git") throw new Error("only git");
    const args = argv.slice(1);
    const remote = ["fetch", "ls-remote", "push"].some((c) => args.includes(c)) ? args.map((a) => (a === "origin" ? bare : a)) : args;
    return runBounded(["git", ...IDENTITY, ...remote], opts);
  };
  const file = (path: string, text: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), text); };
  const commit = async (msg: string) => { await git("add", "-A"); await git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  /** A PR branch named `name` from `from`, with `edit` applied, pushed to origin. */
  const pr = async (name: string, from: string, edit: () => void) => {
    await git("checkout", "-q", "--detach", from); edit();
    const head = await commit(`pr ${name}`);
    await sh(work, "push", "-q", bare, `${head}:refs/heads/${name}`);
    await git("checkout", "-q", "main");
    return head;
  };
  const remoteHead = async (branch: string) => sh(bare, "rev-parse", `refs/heads/${branch}`);
  const trial = (branch: string, head: string) => trialUnionMerge({ repoDir: work, repository: "example/union", branch, reviewedHead: head }, command);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "merge-union-git-")); bare = join(root, "origin.git"); work = join(root, "repo");
    mkdirSync(bare); mkdirSync(work);
    await sh(bare, "init", "-q", "--bare", "-b", "main");
    await sh(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git("init", "-q", "-b", "main");
    await git("remote", "add", "origin", "https://github.com/example/union.git");
    file(KEYS, table()); file("src/x.ts", "export const x = 1;\n");
    preAttrs = await commit("before the union line");
    file(".gitattributes", ATTRS);
    base = await commit("base");
    // KEYSORT1: main's key sorts after every PR key below, so their same-gap union result stays in order
    file(KEYS, table("zMainKey")); file("src/main-only.ts", "export const m = 1;\n");
    mainHead = await commit("main adds a key");
    await sh(work, "push", "-q", bare, "main:refs/heads/main");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("unionPaths reads literal merge=union paths only", () => {
    expect(unionPaths(`# c\n${ATTRS}/b.ts merge=union text\n*.lock merge=union\nc.ts -merge\n`)).toEqual([KEYS, "b.ts"]);
  });

  test("[验收线 2] a key-only conflict merges in a scratch worktree, passes the carry proof and is pushed fast-forward", async () => {
    const head = await pr("keys-only", base, () => file(KEYS, table("prKey")));
    const r = await trial("keys-only", head);
    expect(r).toMatchObject({ ok: true, mainHead, files: [KEYS] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.proof).toContain("干净合并");
    expect(await git("rev-list", "--parents", "-n", "1", r.mergeSha)).toBe(`${r.mergeSha} ${head} ${mainHead}`);
    expect(await git("show", `${r.mergeSha}:${KEYS}`)).toBe(table("prKey", "zMainKey").trim());
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1); // the scratch worktree is gone
    expect(await remoteHead("keys-only")).toBe(head); // trying pushes nothing
    expect(await pushUnionMerge({ repoDir: work, branch: "keys-only", reviewedHead: head, mergeSha: r.mergeSha }, command)).toEqual({ ok: true });
    expect(await remoteHead("keys-only")).toBe(r.mergeSha);
  });

  test("a PR cut before main had the union line still merges like main will", async () => {
    const head = await pr("old-branch", preAttrs, () => file(KEYS, table("oldKey")));
    const r = await trial("old-branch", head);
    expect(r).toMatchObject({ ok: true, files: [KEYS] });
  });

  test("[验收线 2] a conflict in another file too is refused and nothing is pushed", async () => {
    const head = await pr("two-files", base, () => { file(KEYS, table("prKey")); file("src/main-only.ts", "export const m = 2;\n"); });
    const r = await trial("two-files", head);
    expect(r).toMatchObject({ ok: false, reason: "冲突不只在 union 文件：src/main-only.ts", mainHead });
    expect(await remoteHead("two-files")).toBe(head);
  });

  test("a DIRTY that is no conflict without attributes, and a merge the CARRY2 criteria refuse, are both refused", async () => {
    const clean = await pr("no-conflict", base, () => file("src/y.ts", "export const y = 1;\n"));
    expect(await trial("no-conflict", clean)).toMatchObject({ ok: false, reason: "不带 attributes 也能干净合并，DIRTY 不是 union 文件的冲突" });
    // a binary change beside the key: the merge is clean, but CARRY2 takes binary changes only on the byte-exact proof
    const binary = await pr("binary", base, () => { file(KEYS, table("prKey")); writeFileSync(join(work, "blob.bin"), Buffer.from([0, 1, 2, 255])); });
    const r = await trial("binary", binary);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("沿用证明不成立：合并 main 后 PR 对 main 的净 diff 变了；干净合并证明不成立：binary / gitlink / mode 改动只认逐字证明");
    expect(await remoteHead("binary")).toBe(binary);
  });

  test("[验收线 2] the precheck applies the CARRY2 criteria whatever the live mainCarryMerge mode (r1 union-precheck-live-carry-mode)", async () => {
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mainCarryMerge: "observe" } } } }));
    try {
      const head = await pr("carry-observe", base, () => file(KEYS, table("prKey")));
      expect(await trial("carry-observe", head)).toMatchObject({ ok: true, files: [KEYS] });
    } finally { rmSync(RECOVERY_POLICY_PATH, { force: true }); }
  });

  test("[验收线 4] the branch is reset to an ancestor of the merge between ls-remote and push: the push is refused (r1 union-push-head-check-race)", async () => {
    const head = await pr("race", base, () => file(KEYS, table("prKey")));
    const r = await trial("race", head);
    if (!r.ok) throw new Error(r.reason);
    const racing: typeof runBounded = async (argv, opts) => {
      if (argv.includes("push")) await sh(bare, "update-ref", "refs/heads/race", mainHead); // after the ls-remote read, before the push
      return command(argv, opts);
    };
    expect(await pushUnionMerge({ repoDir: work, branch: "race", reviewedHead: head, mergeSha: r.mergeSha }, racing)).toMatchObject({ ok: false, moved: true });
    expect(await remoteHead("race")).toBe(mainHead);
  });

  test("[验收线 4] the branch moved since review: ls-remote refuses the push and the branch is untouched", async () => {
    const head = await pr("moved", base, () => file(KEYS, table("prKey")));
    const r = await trial("moved", head);
    if (!r.ok) throw new Error(r.reason);
    const author = await pr("moved", head, () => file("src/z.ts", "export const z = 1;\n"));
    expect(await pushUnionMerge({ repoDir: work, branch: "moved", reviewedHead: head, mergeSha: r.mergeSha }, command))
      .toMatchObject({ ok: false, moved: true });
    expect(await remoteHead("moved")).toBe(author);
  });

  describe("through the merge driver (mergeUnion on, real git ports)", () => {
    const notes: UnionNote[] = [];
    beforeEach(() => { notes.length = 0; });
    const drive = async (branch: string, head: string) => {
      const steps: { to: string; receipt?: string }[] = [];
      let run = { intentId: "i", taskId: "t", project: "p", prRef: "https://github.com/example/union/pull/7", expectedBranch: branch,
        reviewedHead: head, requiredChecks: "test", phase: "ready", rev: 1, mergeSha: null, reason: null, unknownSince: null } as unknown as MergeRun;
      const snapshot: PrSnapshot = { state: "OPEN", head, branch, crossRepository: false, base: "main", draft: false, mergeState: "DIRTY",
        mergeSha: null, checks: [] };
      const external: MergeExternal = { inspect: async () => snapshot, freshness: async () => ({ behindBy: 1, mainHead }),
        carryReview: async () => ({ ok: false, reason: "not here" }), updateBranch: async () => { throw new Error("no update-branch"); },
        merge: async () => { throw new Error("no merge"); }, direct: () => true, unknownRereadMs: 0 };
      using _ports = useMergeUnionPorts({ mode: () => "on", repoDir: () => work,
        trial: (i) => trialUnionMerge(i, command), push: (i) => pushUnionMerge(i, command), note: async (n) => { notes.push(n); } });
      await driveMerge(run, external, async (_f, to, _r, receipt) => { steps.push({ to, receipt }); run = { ...run, phase: to, rev: run.rev + 1 }; return run; });
      return steps;
    };

    test("[验收线 2] key-only: claims updating, pushes the merge commit, no bounce", async () => {
      const head = await pr("drive-keys", base, () => file(KEYS, table("driveKey")));
      const steps = await drive("drive-keys", head);
      expect(steps.map((s) => s.to)).toEqual(["updating"]);
      expect(await git("rev-list", "--parents", "-n", "1", await remoteHead("drive-keys"))).toEndWith(`${head} ${mainHead}`);
      expect(notes).toEqual([]);
    });

    test("[验收线 2] another file conflicts: bounced to fix as before, a failure note, nothing pushed", async () => {
      const head = await pr("drive-two", base, () => { file(KEYS, table("driveKey")); file("src/main-only.ts", "export const m = 3;\n"); });
      const steps = await drive("drive-two", head);
      expect(steps).toEqual([{ to: "resolved", receipt: `退回 fix（conflict）：PR head ${head}，main head ${mainHead}` }]);
      expect(await remoteHead("drive-two")).toBe(head);
      expect(notes.map((n) => n.action)).toEqual(["本地 union 解冲突没成：冲突不只在 union 文件：src/main-only.ts"]);
    });
  });
});

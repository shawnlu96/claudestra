import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewMainCarryProof, type MainCarryInput } from "../src/lib/review-main-carry-proof.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { runBounded } from "../src/lib/run-bounded.js";

describe("MAINP1 local immutable main-carry proof", () => {
  let root = "", work = "", oldHead = "", main1 = "", main2 = "", one = "", two = "", base = "";
  const sh = async (...args: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const file = (path: string, value: string | Buffer) => writeFileSync(join(work, path), value);
  const commit = async (message: string) => {
    await sh("add", "-A"); await sh("commit", "-qm", message);
    return sh("rev-parse", "HEAD");
  };
  const at = async (head: string) => {
    await sh("reset", "--hard", "-q"); // discard only this temporary fixture's staged evil trees
    return sh("checkout", "-q", "--detach", head);
  };
  const actualMain = (head: string) => sh("update-ref", "refs/remotes/origin/main", head);
  const input = (newHead = two, over: Partial<MainCarryInput> = {}): MainCarryInput =>
    ({ repoDir: work, repository: "example/proof", base: "main", mainHead: main2, oldHead, newHead, ...over });
  const proof = (newHead = two, over: Partial<MainCarryInput> = {}, run?: typeof runBounded) => reviewMainCarryProof(input(newHead, over), run);
  const treeCommit = async (tree: string, parents: string[], message = "merge") =>
    sh("commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message);
  const gitCommand: typeof runBounded = async (argv, opts) => {
    if (argv[0] !== "git") throw new Error("Only local git is allowed");
    if (argv.includes("fetch")) return { code: 0, stdout: "", stderr: "", timedOut: false }; // objects already in this temporary repo
    return runBounded(argv, opts);
  };
  const legacy = (newHead: string, reviewed = oldHead) => {
    const p = parseSchedulerConfig({ enabled: true, projects: { p: { repoDir: work, maxActiveWorkers: 2, requiredChecks: ["test"] } } }).projects.p;
    return mergeExternal(p, gitCommand).carryReview("https://github.com/example/proof/pull/1", reviewed, newHead);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "main-carry-proof-")); work = join(root, "repo"); mkdirSync(work);
    await sh("init", "-q", "-b", "main");
    await sh("remote", "add", "origin", "https://github.com/example/proof.git");
    file("shared", "original\n"); file("delete", "to delete\n"); file("rename", "to rename\n");
    file("binary", Buffer.from([0, 1, 2, 255]));
    base = await commit("base");
    await sh("checkout", "-qb", "feature");
    file("feature", "reviewed\n"); file("quote \" 中文", "path\n");
    file("binary", Buffer.from([0, 3, 4, 254]));
    await sh("rm", "delete"); await sh("mv", "rename", "renamed");
    oldHead = await commit("reviewed");
    await at(base); file("main1", "main one\n"); main1 = await commit("main one");
    file("main2", "main two\n"); main2 = await commit("main two"); await actualMain(main2);
    await at(oldHead); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
    await sh("merge", "-q", "--no-edit", main2); two = await sh("rev-parse", "HEAD");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("single and multi-hop: complete binary/add/delete/rename diff and frozen ordered evidence", async () => {
    const r = await proof();
    expect(r).toMatchObject({ ok: true, oldHead, newHead: two, mainHead: main2, mainParent: main2,
      chain: [{ head: one, previousHead: oldHead, mainParent: main1 }, { head: two, previousHead: one, mainParent: main2 }] });
    if (!r.ok) throw new Error(r.reason);
    expect(Object.isFrozen(r) && Object.isFrozen(r.chain) && r.chain.every(Object.isFrozen)).toBe(true);
    const diff = await sh("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
      "--binary", "--full-index", `${main2}...${two}`);
    expect(diff).toContain("GIT binary patch"); expect(diff).toContain("deleted file mode"); expect(diff).toContain("new file mode");
    expect(r.diffHash).toBe(createHash("sha256").update(`${diff}\n`).digest("hex"));
    expect(await legacy(one)).toMatchObject({ ok: true });
    expect(await proof(one)).toMatchObject({ ok: true });
    expect(await legacy(two)).toMatchObject({ ok: false });
    expect(Object.keys(r).sort()).toEqual(["chain", "diffHash", "mainHead", "mainParent", "newHead", "ok", "oldHead", "reason"]);
  });
  test("parent order is immaterial", async () => {
    const reversed = await treeCommit(await sh("rev-parse", `${one}^{tree}`), [main1, oldHead]);
    expect(await proof(reversed)).toMatchObject({ ok: true, chain: [{ head: reversed, previousHead: oldHead, mainParent: main1 }] });
  });
  test("old and new reject hidden merge edits, including binary/deletion/rename paths", async () => {
    for (const [path, body] of [["feature", "hidden\n"], ["binary", Buffer.from([0, 9, 255])], ["delete", "restored\n"], ["renamed", "changed\n"]] as const) {
      await at(one); file(path, body); await sh("add", "-A");
      const evil = await treeCommit(await sh("write-tree"), [oldHead, main1]);
      for (const r of [await legacy(evil), await proof(evil)]) {
        expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff"), mainParent: main1, mainHead: main2 });
      }
    }
  });
  test("multi-hop changed final diff is rejected", async () => {
    await at(two); file("feature", "hidden final change\n"); await sh("add", "-A");
    const evil = await treeCommit(await sh("write-tree"), [one, main2]);
    expect(await proof(evil)).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff") });
    expect((await legacy(evil)).ok).toBe(false);
  });
  test("conflict resolution cannot smuggle content", async () => {
    await at(oldHead); file("shared", "reviewed version\n"); const reviewed = await commit("reviewed conflict");
    await at(main2); file("shared", "main version\n"); const main = await commit("main conflict");
    await at(reviewed);
    const merge = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "--no-commit", main],
      { cwd: work, timeoutMs: 30_000 });
    expect(merge.code).toBe(1);
    file("shared", "hidden resolution\n"); const merged = await commit("resolve");
    await actualMain(main);
    try {
      expect(await proof(merged, { mainHead: main, oldHead: reviewed })).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff") });
      expect((await legacy(merged, reviewed)).ok).toBe(false);
    } finally { await actualMain(main2); }
  });
  test("ordinary, empty author commit, rebase, squash and octopus cannot bridge the reviewed head", async () => {
    const tree = await sh("rev-parse", `${two}^{tree}`);
    const inserted = await treeCommit(await sh("rev-parse", `${one}^{tree}`), [one], "extra author commit");
    const atop = await treeCommit(tree, [inserted, main2]);
    const squash = await treeCommit(tree, [oldHead]);
    const rebase = await treeCommit(tree, [main2]);
    const octopus = await treeCommit(tree, [oldHead, main1, main2]);
    for (const head of [inserted, atop, squash, rebase, octopus]) expect((await proof(head)).ok).toBe(false);
  });
  test("wrong base, repository, actual main and off-main merge parent are rejected", async () => {
    for (const over of [{ base: "release" }, { repository: "other/repo" }, { mainHead: main1 }]) expect((await proof(two, over)).ok).toBe(false);
    await at(main2); file("side", "off main\n"); const side = await commit("side");
    const merged = await treeCommit(await sh("rev-parse", `${one}^{tree}`), [oldHead, side]);
    expect(await proof(merged)).toMatchObject({ ok: false, reason: expect.stringContaining("不在 main") });
    expect((await proof(oldHead)).ok).toBe(false);
    expect((await proof("abcd")).ok).toBe(false);
  });
  test("both main observations bind all ancestry and diff commands to a fixed full SHA", async () => {
    let checks = 0, diffs = 0;
    const move: typeof runBounded = async (argv, opts) => {
      if (argv.includes("diff")) {
        diffs++;
        expect(argv.at(-1)).toStartWith(`${main2}...`);
        if (diffs === 1) await actualMain(main1);
      }
      if (argv.includes("rev-parse")) checks++;
      return gitCommand(argv, opts);
    };
    try {
      expect(await proof(two, {}, move)).toMatchObject({ ok: false, reason: expect.stringContaining("漂移") });
      expect(checks).toBe(2); expect(diffs).toBe(2);
    } finally { await actualMain(main2); }
  });
  test("missing old/new/main objects and command errors never yield proof", async () => {
    await expect(proof("f".repeat(40))).rejects.toThrow();
    await expect(proof(two, { oldHead: "e".repeat(40) })).resolves.toMatchObject({ ok: false });
    await sh("update-ref", "-d", "refs/remotes/origin/main");
    try { await expect(proof()).rejects.toThrow(); } finally { await actualMain(main2); }
    for (const fault of ["timeout", "exit", "throw"] as const) {
      const failed: typeof runBounded = async (argv, opts) => {
        if (!argv.includes("diff")) return gitCommand(argv, opts);
        if (fault === "throw") throw new Error("injected failure");
        return { code: fault === "exit" ? 2 : 0, timedOut: fault === "timeout", stdout: "same partial diff", stderr: "failed" };
      };
      await expect(proof(two, {}, failed)).rejects.toThrow();
    }
  });
  test("900 KiB threshold, truncation and shared stdout/stderr budget fail closed", async () => {
    for (const [stdout, stderr] of [["x".repeat(900 * 1024), ""], ["x".repeat(1024 * 1024), ""], ["partial", "e".repeat(1024 * 1024)]]) {
      const cut: typeof runBounded = async (argv, opts) => argv.includes("diff")
        ? { code: 0, timedOut: false, stdout, stderr } : gitCommand(argv, opts);
      await expect(proof(two, {}, cut)).rejects.toThrow();
    }
    await at(oldHead); file("huge", "x".repeat(920 * 1024)); const large = await commit("huge diff");
    await sh("merge", "-q", "--no-edit", main2); const merged = await sh("rev-parse", "HEAD");
    await expect(proof(merged, { oldHead: large })).rejects.toThrow();
  });
  test("identical short truncated prefixes cannot become equal-diff evidence", async () => {
    const cut: typeof runBounded = async (argv, opts) => {
      const result = await gitCommand(argv, opts);
      return argv.includes("diff") ? { ...result, stdout: result.stdout.slice(0, 20) } : result;
    };
    await expect(proof(two, {}, cut)).rejects.toThrow("读取不完整");
    const p = parseSchedulerConfig({ enabled: true, projects: { p: { repoDir: work, maxActiveWorkers: 2, requiredChecks: ["test"] } } }).projects.p;
    await expect(mergeExternal(p, cut).carryReview("https://github.com/example/proof/pull/1", oldHead, one)).rejects.toThrow("读取不完整");
  });
  test("caller mutation during IO cannot switch bound heads or repository", async () => {
    const request = input();
    const mutate: typeof runBounded = async (argv, opts) => {
      request.oldHead = one; request.newHead = oldHead; request.mainHead = main1; request.repository = "other/repo";
      return gitCommand(argv, opts);
    };
    expect(await reviewMainCarryProof(request, mutate)).toMatchObject({ ok: true, oldHead, newHead: two, mainHead: main2 });
  });
  test("local diff settings cannot hide changed gitlinks or paths outside cwd", async () => {
    await at(oldHead);
    await sh("update-index", "--add", "--cacheinfo", `160000,${base},module`);
    await sh("commit", "-qm", "reviewed gitlink"); const reviewed = await sh("rev-parse", "HEAD");
    await sh("merge", "-q", "--no-edit", main2);
    await sh("update-index", "--cacheinfo", `160000,${main1},module`);
    const evil = await treeCommit(await sh("write-tree"), [reviewed, main2]);
    await sh("config", "diff.ignoreSubmodules", "all");
    await sh("config", "diff.relative", "true");
    const subdir = join(work, "nested"); mkdirSync(subdir, { recursive: true });
    try {
      expect(await proof(evil, { oldHead: reviewed, repoDir: subdir })).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff") });
      expect((await legacy(evil, reviewed)).ok).toBe(false);
    } finally {
      await sh("config", "--unset", "diff.ignoreSubmodules");
      await sh("config", "--unset", "diff.relative");
    }
  });
  test("invalid UTF-8 text bytes cannot collapse to equal replacement characters", async () => {
    await at(oldHead); file("raw", Buffer.from([0xff, 10])); const reviewed = await commit("raw bytes");
    await sh("merge", "-q", "--no-edit", main2);
    file("raw", Buffer.from([0xfe, 10])); await sh("add", "raw");
    const merged = await treeCommit(await sh("write-tree"), [reviewed, main2]);
    expect(await proof(merged, { oldHead: reviewed })).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff") });
    await expect(proof(merged, { oldHead: reviewed }, gitCommand)).rejects.toThrow("UTF-8");
    await expect(legacy(merged, reviewed)).rejects.toThrow("UTF-8");
  });
  test("bounded chain accepts 16, refuses 17 rather than truncating; cyclic command output is refused", async () => {
    const mainTree = await sh("rev-parse", `${main2}^{tree}`), featureTree = await sh("rev-parse", `${two}^{tree}`);
    let main = main2, head = two;
    const heads: string[] = [];
    for (let i = 3; i <= 17; i++) {
      main = await treeCommit(mainTree, [main], `main ${i}`);
      head = await treeCommit(featureTree, [head, main], `merge ${i}`); heads.push(head);
    }
    await actualMain(main);
    try {
      expect((await proof(heads.at(-2)!, { mainHead: main })).ok).toBe(true);
      expect(await proof(head, { mainHead: main })).toMatchObject({ ok: false, reason: expect.stringContaining("链长") });
    } finally { await actualMain(main2); }
    const cyclic: typeof runBounded = async (argv, opts) => argv.includes("rev-list")
      ? { code: 0, timedOut: false, stdout: `${two} ${two} ${main2}\n`, stderr: "" } : gitCommand(argv, opts);
    expect(await proof(two, {}, cyclic)).toMatchObject({ ok: false, reason: expect.stringContaining("循环") });
  });
});

/**
 * EFFAUTO1 git side, on real repositories: a bare "origin" and a clone as the scheduler's repoDir (origin named as a GitHub URL so
 * the repository check holds; fetch / ls-remote / push are pointed at the bare path), holding this checkout's src/lib and
 * scripts/skip-effects.ts. A PR head with one more effect site in a registered file and the inventory unchanged is refreshed in a
 * scratch worktree by the real `bun scripts/skip-effects.ts`, classed count-only by SKIPAUTO1 and pushed fast-forward; exit 1
 * (unregistered file), exit 2 (inventory text vs SKIP_EFFECT_FILES), a refreshed head and a moved branch are refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushCountRefresh, REFRESH_SUBJECT, remoteBranchHead, trialCountRefresh } from "../src/lib/effect-count-refresh-git.js";
import { runBounded } from "../src/lib/run-bounded.js";

const ROOT = join(import.meta.dir, "..");
const INVENTORY = "src/lib/scheduler-v2-skip-effects.ts";
const TARGET = "src/lib/scheduler-merge-conflict.ts"; // registered, reached from the pass
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const EXTRA_SITE = "\nexport const zzEffAuto = (q: { run(): void }) => q.run();\n";

describe("EFFAUTO1 count refresh (real git, real skip-effects)", () => {
  let root = "", bare = "", work = "", base = "";
  const sh = async (cwd: string, ...args: string[]) => {
    const r = await runBounded(["git", ...IDENTITY, ...args], { cwd, timeoutMs: 60_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  const git = (...args: string[]) => sh(work, ...args);
  /** The scheduler's commands, with the remote redirected to the bare repo and a fixed identity for the refresh commit. */
  const command: typeof runBounded = async (argv, opts) => {
    if (argv[0] !== "git") return runBounded(argv, opts); // the skip-effects run itself
    const args = argv.slice(1);
    const remote = ["fetch", "ls-remote", "push"].some((c) => args.includes(c)) ? args.map((a) => (a === "origin" ? bare : a)) : args;
    return runBounded(["git", ...IDENTITY, ...remote], opts);
  };
  const edit = (path: string, f: (text: string) => string) => writeFileSync(join(work, path), f(readFileSync(join(work, path), "utf8")));
  /** A PR branch named `name` from base, with `change` applied, pushed to origin. */
  const pr = async (name: string, change: () => void) => {
    await git("checkout", "-q", "--detach", base); change();
    await git("add", "-A"); await git("commit", "-qm", `pr ${name}`);
    const head = await git("rev-parse", "HEAD");
    await sh(work, "push", "-q", bare, `${head}:refs/heads/${name}`);
    await git("checkout", "-q", "main");
    return head;
  };
  const trial = (branch: string, head: string) => trialCountRefresh({ repoDir: work, repository: "example/eff", branch, head }, command);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "eff-count-refresh-git-")); bare = join(root, "origin.git"); work = join(root, "repo");
    mkdirSync(bare); mkdirSync(join(work, "scripts"), { recursive: true });
    await sh(bare, "init", "-q", "--bare", "-b", "main");
    await sh(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git("init", "-q", "-b", "main");
    await git("remote", "add", "origin", "https://github.com/example/eff.git");
    cpSync(join(ROOT, "src", "lib"), join(work, "src", "lib"), { recursive: true });
    cpSync(join(ROOT, "scripts", "skip-effects.ts"), join(work, "scripts", "skip-effects.ts"));
    await git("add", "-A"); await git("commit", "-qm", "base");
    base = await git("rev-parse", "HEAD");
    await sh(work, "push", "-q", bare, "main:refs/heads/main");
  }, 120_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("[验收线 1] one more site in a registered file: refreshed, count-only, pushed fast-forward; the refreshed head is never refreshed again", async () => {
    const head = await pr("count", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
    const r = await trial("count", head);
    if (!r.ok) throw new Error(r.reason);
    expect(r.files).toEqual([INVENTORY]);
    expect(r.entries).toEqual([{ file: "scheduler-merge-conflict.ts", gate: expect.any(String), from: "sql=3 stmt=3", to: "sql=3 stmt=4" }]);
    expect(await git("rev-list", "--parents", "-n", "1", r.sha)).toBe(`${r.sha} ${head}`);
    expect(await git("log", "-1", "--format=%s", r.sha)).toBe(REFRESH_SUBJECT);
    expect(await git("diff", "--name-only", head, r.sha)).toBe(INVENTORY);
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1); // the scratch worktree is gone
    expect(await remoteBranchHead(work, "count", command)).toBe(head);
    expect(await pushCountRefresh({ repoDir: work, branch: "count", head, sha: r.sha }, command)).toEqual({ ok: true });
    expect(await sh(bare, "rev-parse", "refs/heads/count")).toBe(r.sha);
    const again = await trial("count", r.sha); // spec 6: a refreshed head red on counts again goes back to fix
    expect(again).toMatchObject({ ok: false, reason: expect.stringContaining("本身就是计数刷新提交") });
  }, 120_000);

  test("[验收线 2] an unregistered new file (exit 1) or inventory text out of step with SKIP_EFFECT_FILES (exit 2): refused, nothing committed", async () => {
    const unregistered = await pr("unregistered", () => {
      writeFileSync(join(work, "src/lib/zz-eff-auto-new.ts"), "export const zz = (q: { run(): void }) => q.run();\n");
      appendFileSync(join(work, TARGET), '\nimport { zz } from "./zz-eff-auto-new.js";\nexport const zzAgain = zz;\n');
    });
    expect(await trial("unregistered", unregistered)).toMatchObject({ ok: false, exitCode: 1, reason: expect.stringContaining("未登记") });
    const drift = await pr("drift", () => edit(INVENTORY, (t) => `${t}\n(SKIP_EFFECT_FILES.infra as Record<string, string>)["zz.ts"] = "fs=1";\n`));
    expect(await trial("drift", drift)).toMatchObject({ ok: false, exitCode: 2, reason: expect.stringContaining("对不上") });
    const clean = await pr("clean", () => appendFileSync(join(work, TARGET), "\n// a comment only\n"));
    expect(await trial("clean", clean)).toMatchObject({ ok: false, exitCode: 0, reason: expect.stringContaining("什么都没改") });
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1);
  }, 120_000);

  test("[验收线 3] the branch moved after the trial: the push is refused, the branch keeps the other head", async () => {
    const head = await pr("moved", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
    const r = await trial("moved", head);
    if (!r.ok) throw new Error(r.reason);
    const other = await pr("moved-other", () => appendFileSync(join(work, TARGET), "\n// someone else's push\n"));
    await sh(work, "push", "-q", "-f", bare, `${other}:refs/heads/moved`);
    expect(await pushCountRefresh({ repoDir: work, branch: "moved", head, sha: r.sha }, command)).toMatchObject({ ok: false, moved: true });
    expect(await sh(bare, "rev-parse", "refs/heads/moved")).toBe(other);
  }, 120_000);

  test("a wrong origin or an invalid head is refused before any worktree", async () => {
    expect(await trialCountRefresh({ repoDir: work, repository: "example/other", branch: "count", head: base }, command))
      .toMatchObject({ ok: false, reason: expect.stringContaining("origin") });
    expect(await trialCountRefresh({ repoDir: work, repository: "example/eff", branch: "count", head: "nope" }, command))
      .toMatchObject({ ok: false, reason: "head 或分支名无效" });
  });
});

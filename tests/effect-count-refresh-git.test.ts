/**
 * EFFAUTO1 git side, on real repositories: a bare "origin" and a clone as the scheduler's repoDir (origin named as a GitHub URL so
 * the repository check holds; fetch / ls-remote / push are pointed at the bare path), holding this checkout's src/lib and
 * scripts/skip-effects.ts. A PR head with one more effect site in a registered file and the inventory unchanged is refreshed in a
 * scratch worktree by this process's own rewrite (EFFSAFE1: no PR code runs, every command is git), classed count-only by
 * SKIPAUTO1 and pushed fast-forward; exit 1 (unregistered file), exit 2 (inventory text outside the literal changed), a refreshed
 * head and a moved branch are refused. EFFSAFE1's PR payloads (scanner, inventory, scan module), environment, symlink and FIFO
 * cases run through effCountRefreshStep with the real trial.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effCountRefreshStep, useEffCountRefreshPorts, type RefreshNote } from "../src/lib/effect-count-refresh.js";
import { pushCountRefresh, REFRESH_SUBJECT, remoteBranchHead, trialCountRefresh, worktreeEnv } from "../src/lib/effect-count-refresh-git.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";
import type { CiFailure } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import type { PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "../src/lib/scheduler-merge.js";

const ROOT = join(import.meta.dir, "..");
const INVENTORY = "src/lib/scheduler-v2-skip-effects.ts";
const TARGET = "src/lib/scheduler-merge-conflict.ts"; // registered, reached from the pass
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const EXTRA_SITE = "\nexport const zzEffAuto = (q: { run(): void }) => q.run();\n";
const FAKE = { GH_TOKEN: "ghp_fake_effsafe1_token", GITHUB_TOKEN: "ghs_fake_effsafe1_token", ZZ_EFFSAFE_API_KEY: "sk-fake-effsafe1" };
const ALLOWED_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "DISCORD_CHANNEL_ID", "CLAUDESTRA_SCHEDULER_SERVICE", "GIT_TERMINAL_PROMPT"];
/** The CI red the merge queue would read: only the inventory groups failed. */
const COUNT_RED: CiFailure[] = [{ file: "tests/skip-effects.test.ts", name: "EFFCNT1 real inventory end to end > the real inventory matches the scan",
  timedOut: false }];
interface Call { argv: string[]; cwd?: string; env?: Record<string, string | undefined> }

describe("EFFAUTO1 count refresh (real git, real skip-effects)", () => {
  let root = "", bare = "", work = "", base = "";
  /** Runs right before the scheduler's `git push` reaches the remote (after its last ls-remote): another writer's race. */
  let beforePush: (() => Promise<unknown>) | null = null;
  const sh = async (cwd: string, ...args: string[]) => {
    const r = await runBounded(["git", ...IDENTITY, ...args], { cwd, timeoutMs: 60_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  const git = (...args: string[]) => sh(work, ...args);
  /** Every command the scheduler side ran since the last test (argv, cwd, env as given). */
  let calls: Call[] = [];
  /** The scheduler's commands, with the remote redirected to the bare repo and a fixed identity for the refresh commit. */
  const command: typeof runBounded = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts.cwd, env: opts.env });
    if (argv[0] !== "git") return runBounded(argv, opts); // before EFFSAFE1: the skip-effects run itself
    const args = argv.slice(1);
    if (args.includes("push") && beforePush) { const race = beforePush; beforePush = null; await race(); }
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
  afterEach(() => { calls = []; });
  /** [验收线 4] the scheduler ran git and nothing else (no `bun scripts/skip-effects.ts`, no process.execPath). */
  const onlyGit = () => expect(calls.map((c) => c.argv[0]).filter((a) => a !== "git")).toEqual([]);

  test("[验收线 4] one more site in a registered file: refreshed, count-only, pushed fast-forward; the refreshed head is never refreshed again", async () => {
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
    onlyGit();
  }, 120_000);

  test("[验收线 4] an unregistered new file (exit 1), inventory text changed outside the literal (exit 2), comments only: refused", async () => {
    const unregistered = await pr("unregistered", () => {
      writeFileSync(join(work, "src/lib/zz-eff-auto-new.ts"), "export const zz = (q: { run(): void }) => q.run();\n");
      appendFileSync(join(work, TARGET), '\nimport { zz } from "./zz-eff-auto-new.js";\nexport const zzAgain = zz;\n');
    });
    expect(await trial("unregistered", unregistered)).toMatchObject({ ok: false, exitCode: 1, reason: expect.stringContaining("未登记") });
    const drift = await pr("drift", () => edit(INVENTORY, (t) => `${t}\n(SKIP_EFFECT_FILES.infra as Record<string, string>)["zz.ts"] = "fs=1";\n`));
    expect(await trial("drift", drift)).toMatchObject({ ok: false, exitCode: 2, reason: expect.stringContaining("清单字面量以外有改动") });
    const clean = await pr("clean", () => appendFileSync(join(work, TARGET), "\n// a comment only\n"));
    expect(await trial("clean", clean)).toMatchObject({ ok: false, exitCode: 0, reason: expect.stringContaining("什么都没改") });
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1);
    onlyGit();
  }, 120_000);

  test("[验收线 4] the branch moved after the trial: the push is refused, the branch keeps the other head", async () => {
    const head = await pr("moved", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
    const r = await trial("moved", head);
    if (!r.ok) throw new Error(r.reason);
    const other = await pr("moved-other", () => appendFileSync(join(work, TARGET), "\n// someone else's push\n"));
    await sh(work, "push", "-q", "-f", bare, `${other}:refs/heads/moved`);
    expect(await pushCountRefresh({ repoDir: work, branch: "moved", head, sha: r.sha }, command)).toMatchObject({ ok: false, moved: true });
    expect(await sh(bare, "rev-parse", "refs/heads/moved")).toBe(other);
    onlyGit();
  }, 120_000);

  test("[验收线 4] the branch rewound to an ancestor or deleted between the ls-remote and the push: refused, the remote keeps it", async () => {
    const head = await pr("rewind", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
    const r = await trial("rewind", head);
    if (!r.ok) throw new Error(r.reason);
    beforePush = () => sh(bare, "update-ref", "refs/heads/rewind", base, head); // a plain push would take this as a fast-forward
    expect(await pushCountRefresh({ repoDir: work, branch: "rewind", head, sha: r.sha }, command)).toMatchObject({ ok: false, moved: true });
    expect(await sh(bare, "rev-parse", "refs/heads/rewind")).toBe(base);
    await sh(bare, "update-ref", "refs/heads/rewind", head, base);
    beforePush = () => sh(bare, "update-ref", "-d", "refs/heads/rewind", head);
    expect(await pushCountRefresh({ repoDir: work, branch: "rewind", head, sha: r.sha }, command)).toMatchObject({ ok: false, moved: true });
    expect(await sh(bare, "for-each-ref", "refs/heads/rewind")).toBe("");
    expect(beforePush).toBeNull(); // both races ran
  }, 120_000);

  /** process.env carries the fake tokens for the length of f: the scheduler's own environment during a trial. */
  const withTokens = async <T>(f: () => Promise<T>): Promise<T> => {
    const before = Object.fromEntries(Object.keys(FAKE).map((k) => [k, process.env[k]]));
    Object.assign(process.env, FAKE);
    try { return await f(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  const runOf = (branch: string, head: string): MergeRun => ({ intentId: `i-${branch}`, taskId: `T-${branch}`, project: "p",
    prRef: "https://github.com/example/eff/pull/1", expectedBranch: branch, reviewedHead: head, requiredChecks: "ci", phase: "await_ci", rev: 1,
    mergeSha: null, reason: null, createdAt: 0, updatedAt: 0 });
  const prOf = (branch: string, head: string): PrSnapshot => ({ state: "OPEN", head, branch, base: "main", draft: false, crossRepository: false,
    mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail" }] });
  /** effCountRefreshStep in `mode` with the real trial / ls-remote / push on this fixture, tokens in the environment. */
  const step = async (mode: RecoveryMode, branch: string, head: string) => {
    const notes: RefreshNote[] = [], run = runOf(branch, head);
    let gh = 0, bounced = 0;
    using _ports = useEffCountRefreshPorts({ mode: () => mode, repoDir: () => work, trial: (i) => trialCountRefresh(i, command),
      remoteHead: (r, b) => remoteBranchHead(r, b, command), push: (i) => pushCountRefresh(i, command), note: async (n) => { notes.push(n); } });
    const out = await withTokens(() => effCountRefreshStep(run, prOf(branch, head), async (to: MergePhase) => ({ ...run, phase: to }),
      async () => { gh++; return COUNT_RED; }, async () => { bounced++; return run; }));
    return { out, notes, gh, bounced, data: notes[0]?.data };
  };
  /** Top-level code that, if anything ever runs it, leaves the scheduler's GH_TOKEN in `mark`. */
  const payload = (mark: string) => `\n;require("node:fs").writeFileSync(${JSON.stringify(mark)}, String(process.env.GH_TOKEN));\n`;

  test("[验收线 1] payloads in the scanner, outside the inventory literal and in the scan module never run (observe, on); count-only still pushes; off runs nothing",
    async () => {
      for (const [v, file] of [["a", "scripts/skip-effects.ts"], ["b", INVENTORY], ["c", "src/lib/skip-effects-auto-scope-scan.ts"]] as const) {
        const mark = join(root, `mark-${v}`);
        const head = await pr(`payload-${v}`, () => { appendFileSync(join(work, file), payload(mark)); appendFileSync(join(work, TARGET), EXTRA_SITE); });
        for (const mode of ["observe", "on"] as const) {
          calls = [];
          const r = await step(mode, `payload-${v}`, head);
          expect(existsSync(mark) ? `${v}/${mode}: ${readFileSync(mark, "utf8")}` : null).toBeNull();
          expect(r).toMatchObject({ out: null, bounced: 0, gh: 1 }); // null = the caller's old bounce to fix follows
          expect(r.notes.map((n) => n.action)).toEqual([expect.stringContaining(mode === "observe" ? "不可修，仍退回 fix" : "没成，退回 fix")]);
          if (v === "b") expect(r.data).toMatchObject({ exitCode: 2, reason: expect.stringContaining("清单字面量以外有改动") });
          else {
            expect(r.data).toMatchObject({ reason: expect.stringContaining("PR 改了扫描器 / 判定器"), files: [file] });
            expect(calls.filter((c) => c.argv.includes("worktree"))).toEqual([]); // refused before any worktree
          }
          expect(calls.filter((c) => c.argv.includes("push"))).toEqual([]);
          onlyGit();
        }
        expect(await sh(bare, "rev-parse", `refs/heads/payload-${v}`)).toBe(head);
      }
      const head = await pr("payload-ok", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
      calls = [];
      expect(await step("off", "payload-ok", head)).toMatchObject({ out: null, notes: [], gh: 0 });
      expect(calls).toEqual([]); // off: no git, no gh, no worktree
      const on = await step("on", "payload-ok", head);
      expect(on.out?.phase).toBe("updating");
      expect(on.notes.map((n) => n.actionKey.split(".")[0])).toEqual(["pushed"]);
      const sha = String(on.data?.newHead);
      expect(await sh(bare, "rev-parse", "refs/heads/payload-ok")).toBe(sha);
      expect(await git("rev-list", "--parents", "-n", "1", sha)).toBe(`${sha} ${head}`);
      expect(await git("diff", "--name-only", head, sha)).toBe(INVENTORY);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.argv[0] !== "git" || c.argv.includes(process.execPath))).toEqual([]);
    }, 300_000);

  test("[验收线 2] every command in the scratch worktree gets only the allowlisted environment; /usr/bin/env under worktreeEnv has no token", async () => {
    const head = await pr("env", () => appendFileSync(join(work, TARGET), EXTRA_SITE));
    const r = await withTokens(() => trial("env", head));
    if (!r.ok) throw new Error(r.reason);
    const inWorktree = calls.filter((c) => c.cwd !== undefined && c.cwd !== work);
    expect(inWorktree.length).toBeGreaterThan(5);
    expect(inWorktree.flatMap((c) => Object.keys(c.env ?? process.env).filter((k) => !ALLOWED_ENV.includes(k)).map((k) => `${c.argv.join(" ")}: ${k}`)))
      .toEqual([]);
    onlyGit();
    const env = await withTokens(() => runBounded(["/usr/bin/env"], { env: worktreeEnv(), timeoutMs: 10_000 }));
    expect(env.code).toBe(0);
    expect(env.stdout).toContain("PATH=");
    for (const [k, v] of Object.entries(FAKE)) expect([env.stdout.includes(k), env.stdout.includes(v)]).toEqual([false, false]);
  }, 120_000);

  test("[验收线 3] an inventory symlinked (120000) to an outside copy is refused and the copy stays byte for byte", async () => {
    const copy = join(root, "outside-inventory.ts");
    writeFileSync(copy, readFileSync(join(work, INVENTORY)));
    const before = readFileSync(copy);
    const head = await pr("link", () => {
      unlinkSync(join(work, INVENTORY)); symlinkSync(copy, join(work, INVENTORY)); appendFileSync(join(work, TARGET), EXTRA_SITE);
    });
    expect(await sh(work, "ls-tree", head, "--", INVENTORY)).toStartWith("120000 ");
    expect(await trial("link", head)).toMatchObject({ ok: false });
    expect(readFileSync(copy).equals(before)).toBe(true);
    onlyGit();
  }, 120_000);

  test("[验收线 3] a pass-graph file symlinked to a FIFO is refused within 5 seconds", async () => {
    const fifo = join(root, "effsafe1.fifo");
    expect((await runBounded(["mkfifo", fifo], { timeoutMs: 10_000 })).code).toBe(0);
    const head = await pr("fifo", () => { unlinkSync(join(work, TARGET)); symlinkSync(fifo, join(work, TARGET)); });
    try {
      const r = await Promise.race([trial("fifo", head), Bun.sleep(5_000).then(() => "timed out after 5 s")]);
      expect(r).toMatchObject({ ok: false });
    } finally {
      // a reader blocked on the FIFO (main's skip-effects child) gets EOF from this open + close, so a red here cannot hang CI
      try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* ENXIO: nobody is reading, nothing to release */ }
    }
    onlyGit();
  }, 30_000);

  test("a wrong origin or an invalid head is refused before any worktree", async () => {
    expect(await trialCountRefresh({ repoDir: work, repository: "example/other", branch: "count", head: base }, command))
      .toMatchObject({ ok: false, reason: expect.stringContaining("origin") });
    expect(await trialCountRefresh({ repoDir: work, repository: "example/eff", branch: "count", head: "nope" }, command))
      .toMatchObject({ ok: false, reason: "head 或分支名无效" });
  });
});

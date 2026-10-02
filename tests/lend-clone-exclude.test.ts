/** 真 git：交付文件可读但不会随 git add -A 进入订单提交；副本自己的 exclude 规则保留。 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClone, type Run } from "../src/lib/lend-clone.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lend-exclude-"));
  roots.push(root);
  const env = { PATH: process.env.PATH, HOME: root, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_ROOT: root };
  const bare = join(root, "git", "o", "r.git");
  const seed = join(root, "seed");
  mkdirSync(bare, { recursive: true });
  mkdirSync(seed);
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe",
      env: testChildEnv({ ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }) });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "code.txt"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed");
  git(seed, "push", "-q", bare, "main");
  return { root, env, git, head: git(seed, "rev-parse", "HEAD") };
}

for (const role of ["write", "review"] as const) {
  test(`${role} 副本：交付文件可读、status 干净、add -A 不暂存；普通源码仍可提交`, async () => {
    const f = fixture();
    const run: Run = async (argv, opts) => {
      const r = await runBounded(argv, opts);
      if (argv[1] === "init" && r.code === 0) writeFileSync(join(opts.cwd!, ".git", "info", "exclude"), "/keep.local");
      return r;
    };
    const write = role === "write" ? { branch: "lend/LEX1-abcd", name: "test", email: "test@example.invalid" } : undefined;
    const c = await prepareClone({ orderId: role, repo: "o/r", pr: null, head: f.head, write }, { root: join(f.root, "lend"), env: f.env, run });
    expect(c.ok).toBe(true);
    if (!c.ok) throw new Error(c.reason);
    const files = role === "write" ? { "summary.txt": "完成源码修改\n", "selfcheck.md": "自查通过\n" }
      : { "report.md": "审查通过\n", "findings.json": "[]\n" };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(c.dir, name), content);
    writeFileSync(join(c.dir, "keep.local"), "local\n");
    expect(f.git(c.dir, "status", "--porcelain")).toBe("");
    f.git(c.dir, "add", "-A");
    expect(f.git(c.dir, "status", "--porcelain")).toBe("");
    expect(f.git(c.dir, "diff", "--cached", "--name-only")).toBe("");
    for (const [name, content] of Object.entries(files)) expect(readFileSync(join(c.dir, name), "utf8")).toBe(content);
    expect(readFileSync(join(c.dir, ".git", "info", "exclude"), "utf8")).toStartWith("/keep.local\n");
    writeFileSync(join(c.dir, "code.txt"), "changed\n");
    mkdirSync(join(c.dir, "docs"));
    const nested = Object.keys(files)[0]!;
    writeFileSync(join(c.dir, "docs", nested), "repository document\n");
    f.git(c.dir, "add", "-A");
    expect(f.git(c.dir, "diff", "--cached", "--name-only").split("\n")).toEqual(["code.txt", `docs/${nested}`]);
  });
}

test("exclude 无法写入：失败返回，不启动未保护的副本", async () => {
  const f = fixture();
  const run: Run = async (argv, opts) => {
    const r = await runBounded(argv, opts);
    if (argv.includes("HEAD:refs/remotes/origin/HEAD") && r.code === 0) {
      const exclude = join(opts.cwd!, ".git", "info", "exclude");
      rmSync(exclude);
      mkdirSync(exclude);
    }
    return r;
  };
  const c = await prepareClone({ orderId: "exclude-error", repo: "o/r", pr: null, head: f.head }, { root: join(f.root, "lend"), env: f.env, run });
  expect(c).toMatchObject({ ok: false, reason: expect.stringContaining("排除交付文件失败") });
});

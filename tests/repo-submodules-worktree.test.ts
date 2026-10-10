/**
 * i28-SECPOOL3：本机执行者 worktree（scheduler-local-author.ts prepareAuthorTree）和审查 worktree（scheduler-review-worktree.ts）
 * 对带子模块的仓库拉子模块、拉失败返回现有失败形式；没有 .gitmodules 调用序列不变。真 git，临时仓库。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAuthorTree } from "../src/lib/scheduler-local-author.js";
import { openReviewWorktree, type Git } from "../src/lib/scheduler-review-worktree.js";
import { testChildEnv } from "./test-env.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function lab() {
  const root = mkdtempSync(join(tmpdir(), "repo-sub-wt-"));
  dirs.push(root);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, '[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n');
  const env = testChildEnv({ GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  const calls: string[][] = [];
  const g: Git = async (args) => {
    calls.push(args);
    const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: (code === 0 ? out : err || out).trim() };
  };
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const sub = join(root, "sub"), repo = join(root, "repo");
  for (const d of [sub, repo]) (mkdirSync(d), sh(d, "init", "-q"));
  writeFileSync(join(sub, "lib.ts"), "export const x = 1;\n");
  sh(sub, "add", "-A"); sh(sub, "commit", "-q", "-m", "sub");
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "a");
  const addSub = (gitlink?: string) => {
    sh(repo, "submodule", "add", "-q", `file://${sub}`, "vendor/sub");
    if (gitlink) sh(repo, "update-index", "--cacheinfo", `160000,${gitlink},vendor/sub`);
    sh(repo, "commit", "-q", "-m", "sub");
    return sh(repo, "rev-parse", "HEAD");
  };
  return { root, repo, sub, subHead: sh(sub, "rev-parse", "HEAD"), g, calls, sh, addSub };
}

describe("本机执行者 worktree：prepareAuthorTree", () => {
  test("带子模块：拉到记录的提交，主 clone 里子模块目录下的 node_modules 一并软链", async () => {
    const L = lab();
    L.addSub();
    for (const d of ["node_modules", "vendor/sub/node_modules"]) mkdirSync(join(L.repo, d), { recursive: true });
    const wt = join(L.root, "wt");
    L.sh(L.repo, "worktree", "add", "-q", "-b", "card", wt);
    expect(existsSync(join(wt, "vendor", "sub", "lib.ts"))).toBe(false);
    expect(await prepareAuthorTree(L.repo, wt, L.g)).toBeNull();
    expect(L.sh(join(wt, "vendor", "sub"), "rev-parse", "HEAD")).toBe(L.subHead);
    for (const d of ["node_modules", "vendor/sub/node_modules"]) {
      expect(lstatSync(join(wt, d)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(wt, d))).toBe(join(L.repo, d));
    }
    expect(existsSync(join(wt, "web", "node_modules"))).toBe(false); // 主 clone 没有的不管
  });

  test("子模块提交不存在：返回失败原因（字符串，写明子模块），不吞错", async () => {
    const L = lab();
    L.addSub("d".repeat(40));
    const wt = join(L.root, "wt");
    L.sh(L.repo, "worktree", "add", "-q", "-b", "card", wt);
    expect(await prepareAuthorTree(L.repo, wt, L.g)).toEqual(expect.stringContaining("子模块"));
  });

  test("没有 .gitmodules：一次 git 都不调，node_modules 照旧软链", async () => {
    const L = lab();
    mkdirSync(join(L.repo, "node_modules"));
    const wt = join(L.root, "wt");
    L.sh(L.repo, "worktree", "add", "-q", "-b", "card", wt);
    expect(await prepareAuthorTree(L.repo, wt, L.g)).toBeNull();
    expect(L.calls).toEqual([]);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
  });
});

describe("审查 worktree：openReviewWorktree", () => {
  test("带子模块：worktree add 之后拉子模块，审查员看得到子模块代码", async () => {
    const L = lab();
    const head = L.addSub();
    const dir = join(L.root, "review");
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ dir });
    expect(L.sh(join(dir, "vendor", "sub"), "rev-parse", "HEAD")).toBe(L.subHead);
    const pin = L.calls.findIndex((a) => a.includes("checkout"));
    expect(L.calls[pin + 2]).toEqual(["-C", dir, "submodule", "update", "--init", "--recursive"]); // 固定 head、核过 HEAD 之后
  });

  test("子模块拉失败：返回 { manual }，写明子模块", async () => {
    const L = lab();
    const head = L.addSub("d".repeat(40));
    expect(await openReviewWorktree(L.repo, join(L.root, "review"), head, L.g)).toEqual({ manual: expect.stringContaining("子模块") });
  });

  test("复用已有目录：上次子模块拉失败，同 head 重试照样拉、照样返回 { manual }，不当成功", async () => {
    const L = lab();
    const head = L.addSub("d".repeat(40)), dir = join(L.root, "review");
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ manual: expect.stringContaining("子模块") });
    expect(existsSync(dir)).toBe(true);
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ manual: expect.stringContaining("子模块") });
  });

  test("复用已有目录：从 h1 切到改了 gitlink 的 h2，子模块跟到 h2 记录的提交", async () => {
    const L = lab();
    const h1 = L.addSub(), dir = join(L.root, "review");
    expect(await openReviewWorktree(L.repo, dir, h1, L.g)).toEqual({ dir });
    writeFileSync(join(L.sub, "lib.ts"), "export const x = 2;\n");
    L.sh(L.sub, "commit", "-q", "-am", "sub2");
    const sub2 = L.sh(L.sub, "rev-parse", "HEAD");
    L.sh(join(L.repo, "vendor", "sub"), "pull", "-q", "origin", "HEAD");
    L.sh(L.repo, "commit", "-q", "-am", "bump sub");
    const h2 = L.sh(L.repo, "rev-parse", "HEAD");
    expect(await openReviewWorktree(L.repo, dir, h2, L.g)).toEqual({ dir });
    expect(L.sh(join(dir, "vendor", "sub"), "rev-parse", "HEAD")).toBe(sub2);
  });

  test("复用已有目录、没有 .gitmodules：只有 exclude + 固定，不多出调用", async () => {
    const L = lab();
    const head = L.sh(L.repo, "rev-parse", "HEAD"), dir = join(L.root, "review");
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ dir });
    L.calls.splice(0);
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ dir });
    expect(L.calls.map((a) => a[2])).toEqual(["rev-parse", "status", "checkout", "rev-parse"]);
  });

  test("没有 .gitmodules：git 调用序列和改动前一致", async () => {
    const L = lab();
    const head = L.sh(L.repo, "rev-parse", "HEAD"), dir = join(L.root, "review");
    expect(await openReviewWorktree(L.repo, dir, head, L.g)).toEqual({ dir });
    expect(L.calls).toEqual([
      ["-C", L.repo, "rev-parse", "--show-toplevel"],
      ["-C", L.repo, "worktree", "add", "--detach", dir, head],
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["-C", dir, "status", "--porcelain", "--untracked-files=no"],
      ["-C", dir, "checkout", "-q", "--detach", head],
      ["-C", dir, "rev-parse", "HEAD"],
    ]);
  });
});

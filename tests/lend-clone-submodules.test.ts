/**
 * i28-SECPOOL3：出借 clone 拉子模块（src/lib/lend-clone.ts + repo-submodules.ts）。lab 本地 bare 仓库造带子模块的仓库（真 git）：
 * 子模块检出到 .gitmodules 记录的提交、上锁后照样推不出去拿不到凭据；子模块拉不下来不起 worker、不留上锁的副本；
 * 子模块里的软链和主仓同一规则；没有 .gitmodules 调用序列不变；GitHub 地址的取和拉子模块带 gh 凭据参数、lab 不带。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareClone, WRITE_LOCK, type Run } from "../src/lib/lend-clone.js";
import { ghCredentialArgs } from "../src/lib/lend-git.js";
import { writeLab, writeResources } from "./lend-write-fixture.ts";

let resources = writeResources();
afterEach(async () => {
  const owned = resources;
  resources = writeResources();
  await owned.dispose();
});
const BR = "lend/T1-abcd";
const W = { branch: BR, name: "lender", email: "l@x" };
const GH = ["-c", "credential.helper=!gh auth git-credential"];

/** lab 里再造一个子模块仓库 o/sub（带一个软链），主仓 seed 加成 vendor/sub 推上去；file:// 子模块要出借人全局配置放行 file 协议 */
function subLab() {
  const L = writeLab(resources);
  L.env.GIT_CONFIG_GLOBAL = join(L.env.HOME, ".gitconfig");
  writeFileSync(L.env.GIT_CONFIG_GLOBAL, '[protocol "file"]\n\tallow = always\n');
  const subBare = join(L.root, "git", "o", "sub.git"), subSeed = join(L.root, "sub-seed");
  mkdirSync(subBare, { recursive: true });
  mkdirSync(subSeed);
  L.git(subBare, "init", "-q", "--bare", "-b", "main");
  L.git(subSeed, "init", "-q", "-b", "main");
  writeFileSync(join(subSeed, "lib.ts"), "export const x = 1;\n");
  symlinkSync("lib.ts", join(subSeed, "alias.ts"));
  L.git(subSeed, "add", "-A");
  L.git(subSeed, "commit", "-q", "-m", "sub");
  L.git(subSeed, "push", "-q", subBare, "main");
  const subHead = L.git(subSeed, "rev-parse", "HEAD");
  return { ...L, subBare, subSeed, subHead };
}

/** 主仓 seed 加子模块并推成新的 main；返回新 head */
function addSubmodule(S: ReturnType<typeof subLab>, gitlink?: string): string {
  S.git(S.seed, "submodule", "add", "-q", `file://${S.subBare}`, "vendor/sub");
  if (gitlink) S.git(S.seed, "update-index", "--cacheinfo", `160000,${gitlink},vendor/sub`);
  S.git(S.seed, "commit", "-q", "-m", "add sub");
  S.git(S.seed, "push", "-q", S.bare, "main");
  return S.git(S.seed, "rev-parse", "HEAD");
}

const recorder = (inner: Run, calls: string[][]): Run => (argv, opts) => (calls.push(argv), inner(argv, opts));

describe("出借 clone 拉子模块（真 git，lab）", () => {
  test("验收 1：子模块检出到记录的提交，软链照旧检出成文本；上锁后 worker 推不出去、拿不到凭据", async () => {
    const S = subLab();
    const head = addSubmodule(S);
    const c = await prepareClone({ orderId: "s1", repo: "o/r", pr: null, head, write: W }, { root: S.lendRoot, env: S.env, run: S.run });
    expect(c.ok).toBe(true);
    const dir = (c as { dir: string }).dir;
    const sub = join(dir, "vendor", "sub");
    expect(S.git(sub, "rev-parse", "HEAD")).toBe(S.subHead);
    expect(S.git(dir, "ls-tree", "HEAD", "vendor/sub").split(/\s+/)[2]).toBe(S.subHead);
    expect(readFileSync(join(sub, "lib.ts"), "utf8")).toContain("x = 1");
    expect(lstatSync(join(sub, "alias.ts")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sub, "alias.ts"), "utf8")).toBe("lib.ts");
    for (const [k, v] of WRITE_LOCK) expect(S.git(dir, "config", "--get", k) === v || v === "").toBe(true);
    expect(S.tryGit(dir, "config", "--get", "credential.helper").stdout).toBe("");
    S.commit(dir, "b.txt");
    for (const target of ["origin", S.bare, `file://${S.bare}`]) {
      expect(S.tryGit(dir, "push", target, "HEAD:main")).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
      expect(S.tryGit(dir, "push", target, `HEAD:${BR}`)).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
    }
    // 子模块自己的远端同样推不出去：锁经主仓配置对子模块里的 git 也生效
    for (const target of ["origin", S.subBare, `file://${S.subBare}`]) {
      expect(S.tryGit(sub, "push", target, "HEAD:refs/heads/x")).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
    }
    for (const [k, v] of WRITE_LOCK) expect(S.tryGit(sub, "config", "--get", k).stdout).toBe(v);
    expect(S.tryGit(sub, "config", "--get", "protocol.file.allow").stdout).toBe("never"); // 全局放行的逐协议许可在子模块里同样盖掉
    expect(S.git(S.bare, "rev-parse", "main")).toBe(head);
    expect(S.git(S.subBare, "branch", "--list")).toBe("* main");
  });

  test("验收 1：全局 includeIf 只对子模块放行的协议（主仓读不到）在子模块里同样盖成 never，push 被传输层拒绝", async () => {
    const S = subLab();
    const inc = join(S.env.HOME, "sub-only.gitconfig");
    writeFileSync(inc, '[protocol "probe"]\n\tallow = always\n');
    writeFileSync(S.env.GIT_CONFIG_GLOBAL!, `[protocol "file"]\n\tallow = always\n[includeIf "gitdir:**/.git/modules/**"]\n\tpath = ${inc}\n`);
    const head = addSubmodule(S);
    const c = await prepareClone({ orderId: "s5", repo: "o/r", pr: null, head, write: W }, { root: S.lendRoot, env: S.env, run: S.run });
    expect(c.ok).toBe(true);
    const dir = (c as { dir: string }).dir, sub = join(dir, "vendor", "sub");
    expect(S.tryGit(dir, "config", "--get", "protocol.probe.allow").stdout).toBe(""); // 主仓确实看不见这条
    expect(S.tryGit(sub, "config", "--get", "protocol.probe.allow").stdout).toBe("never");
    expect(S.tryGit(sub, "push", "probe::unused", "HEAD:refs/heads/x")).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
  });

  test("验收 2：子模块提交不存在 → ok:false、原因写明子模块，不起 worker，副本没上锁也没切订单分支", async () => {
    const S = subLab();
    const head = addSubmodule(S, "d".repeat(40));
    const calls: string[][] = [];
    const c = await prepareClone({ orderId: "s2", repo: "o/r", pr: null, head, write: W }, { root: S.lendRoot, env: S.env, run: recorder(S.run, calls) });
    expect(c).toMatchObject({ ok: false, reason: expect.stringContaining("子模块") });
    expect(calls.some((a) => a.includes("submodule"))).toBe(true);
    expect(calls.some((a) => a.includes("-b") || a.includes("protocol.allow") || a.includes("user.name"))).toBe(false);
    const dir = join(S.lendRoot, "work", (await import("../src/lib/lend-clone.js")).orderDirName("s2"));
    expect(S.tryGit(dir, "config", "--get", "protocol.allow").stdout).toBe("");
    expect(S.tryGit(dir, "config", "--get", "remote.origin.pushurl").stdout).toBe("");
  });

  test("验收 3：子模块里检出后仍有软链（git 没照 core.symlinks 做）→ 和主仓一样拒绝，不上锁", async () => {
    const S = subLab();
    const head = addSubmodule(S);
    const planting: Run = async (argv, opts) => {
      const r = await S.run(argv, opts);
      if (argv.includes("submodule")) symlinkSync("..", join(opts.cwd!, "vendor", "sub", "up"));
      return r;
    };
    const calls: string[][] = [];
    const c = await prepareClone({ orderId: "s3", repo: "o/r", pr: null, head, write: W }, { root: S.lendRoot, env: S.env, run: recorder(planting, calls) });
    expect(c).toMatchObject({ ok: false, reason: expect.stringContaining(join("vendor", "sub", "up")) });
    expect(calls.some((a) => a.includes("protocol.allow"))).toBe(false);
  });

  test("拉子模块带 core.symlinks=false；子模块失败在上锁之前", async () => {
    const S = subLab();
    const head = addSubmodule(S);
    const calls: string[][] = [];
    expect((await prepareClone({ orderId: "s4", repo: "o/r", pr: null, head, write: W }, { root: S.lendRoot, env: S.env, run: recorder(S.run, calls) })).ok).toBe(true);
    const at = calls.findIndex((a) => a.includes("submodule"));
    expect(calls[at]).toEqual(["git", "-c", "core.symlinks=false", "submodule", "update", "--init", "--recursive"]);
    expect(at).toBeLessThan(calls.findIndex((a) => a.includes("protocol.allow")));
    expect(at).toBeGreaterThan(calls.findIndex((a) => a[1] === "rev-parse" && a[2] === "HEAD"));
  });
});

describe("没有 .gitmodules：调用序列不变（验收 4）", () => {
  test("lab 写单 clone 的 git 调用和改动前逐条一致，没有 submodule、没有凭据参数", async () => {
    const L = writeLab(resources);
    const calls: string[][] = [];
    const c = await prepareClone({ orderId: "n1", repo: "o/r", pr: null, head: L.main, write: W }, { root: L.lendRoot, env: L.env, run: recorder(L.run, calls) });
    expect(c.ok).toBe(true);
    const url = `file://${join(L.root, "git", "o", "r.git")}`;
    const before = [
      ["init", "-q"], ["config", "core.symlinks", "false"], ["remote", "add", "origin", url],
      ["fetch", "--no-tags", "-q", "origin", L.main],
      ["-c", "advice.detachedHead=false", "-c", "core.symlinks=false", "checkout", "-q", "--detach", L.main],
      ["rev-parse", "HEAD"], ["fetch", "--no-tags", "-q", "origin", "HEAD:refs/remotes/origin/HEAD"],
      ["-c", "core.symlinks=false", "checkout", "-q", "-b", BR], ["config", "user.name", "lender"], ["config", "user.email", "l@x"],
      ...WRITE_LOCK.map(([k, v]) => ["config", k, v]),
    ].map((a) => ["git", ...a]);
    expect(calls.slice(0, before.length)).toEqual(before);
    // 其后是 lockProtocols 的读出 / 盖写 / 读回，与改动前同一段代码
    expect(calls.slice(before.length).every((a) => a[1] === "config")).toBe(true);
    expect(calls.flat()).not.toContain("submodule");
  });
});

describe("凭据参数（验收 5）", () => {
  /** 不起真 git：checkout 时在副本里放 .gitmodules，其余一律成功；记 argv */
  const fake = (head: string, calls: string[][]): Run => async (argv, opts) => {
    calls.push(argv);
    if (argv[1] === "init") mkdirSync(join(opts.cwd!, ".git", "info"), { recursive: true });
    if (argv.includes("checkout") && argv.includes("--detach")) writeFileSync(join(opts.cwd!, ".gitmodules"), '[submodule "v"]\n\tpath = vendor/v\n\turl = https://github.com/o/v.git\n');
    return { code: argv.includes("--get-regexp") ? 1 : 0, stdout: argv.includes("rev-parse") ? head : argv.includes("--get") ? "never" : "", stderr: "", timedOut: false };
  };
  const H = "e".repeat(40);

  test("https://github.com/ 地址：三次 fetch 和拉子模块都带 gh 凭据参数，别的命令不带", async () => {
    const root = resources.temp(), calls: string[][] = [];
    const env = { PATH: process.env.PATH, HOME: root };
    expect(await prepareClone({ orderId: "g1", repo: "o/r", pr: 7, head: H, write: W }, { root, env, run: fake(H, calls) })).toMatchObject({ ok: true });
    const withGh = calls.filter((a) => a.join(" ").includes(GH.join(" ")));
    expect(withGh.filter((a) => a.includes("fetch"))).toHaveLength(2); // 订单 head + 默认分支（按 SHA 取到了，不取 refs/pull）
    expect(withGh.filter((a) => a.includes("submodule"))).toEqual([["git", ...GH, "-c", "core.symlinks=false", "submodule", "update", "--init", "--recursive"]]);
    expect(calls.filter((a) => a.includes("fetch")).every((a) => a.slice(1, 3).join(" ") === GH.join(" "))).toBe(true);
    expect(calls.filter((a) => !a.includes("fetch") && !a.includes("submodule")).some((a) => a.includes(GH[1]!))).toBe(false);
  });

  test("按 SHA 取不到、改取 refs/pull 时同样带；lab（file://）地址一个都不带", async () => {
    const root = resources.temp(), calls: string[][] = [];
    const env = { PATH: process.env.PATH, HOME: root };
    const first: Run = async (argv, opts) => (argv.includes(H) && argv.includes("fetch") ? (calls.push(argv), { code: 128, stdout: "", stderr: "x", timedOut: false }) : fake(H, calls)(argv, opts));
    expect(await prepareClone({ orderId: "g2", repo: "o/r", pr: 7, head: H }, { root, env, run: first })).toMatchObject({ ok: true });
    expect(calls.find((a) => a.includes("refs/pull/7/head"))?.slice(1, 3)).toEqual(GH);
    const lab = { ...env, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_ROOT: root }, labCalls: string[][] = [];
    expect(await prepareClone({ orderId: "g3", repo: "o/r", pr: null, head: H }, { root, env: lab, run: fake(H, labCalls) })).toMatchObject({ ok: true });
    expect(labCalls.some((a) => a.includes("submodule"))).toBe(true);
    expect(labCalls.flat().some((x) => x.includes("credential.helper"))).toBe(false);
  });

  test("判断与 lend-push 是同一个函数：lend-push / lend-clone 都调 ghCredentialArgs，源码里不再有第二份", () => {
    expect(ghCredentialArgs("https://github.com/o/r.git")).toEqual(GH);
    expect(ghCredentialArgs("file:///x/git/o/r.git")).toEqual([]);
    for (const f of ["lend-push.ts", "lend-clone.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "lib", f), "utf8");
      expect(src).toContain("ghCredentialArgs(");
      expect(src).not.toContain("credential.helper=!gh");
    }
  });
});

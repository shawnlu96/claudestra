import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getGitHubRepo, getLatestRelease } from "../src/lib/github-release.ts";
import {
  applyRepoMigration, buildRepoPlan, installDefaultUrl, OFFICIAL_REPO, planRepoMigration, PRIVATE_CLOUD_REPO, PROPOSED_REPO, rollbackRepoMigration,
} from "../src/lib/floka-repo/migrate.ts";
import type { MigrationRecord, RecordStore, RepoGit } from "../src/lib/floka-repo/types.ts";
import { isOfficialUrl, parseOfficialShape, releaseApiUrl, releaseSlugOf, rewriteOfficialUrl } from "../src/lib/floka-repo/url.ts";
import { fileRecordStore, gitRepoPort, runRepoCli } from "../scripts/rename-floka/repo-preflight.ts";

// 全程只在临时 Git 仓里:不连 GitHub、不连网络。clone 来自本地源仓,curl / fetch 都是 fake。
const ROOT = join(import.meta.dir, "..");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (p = "floka-repo-") => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); roots.push(d); return d; };

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe", env: ENV });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** 一个有提交的临时仓,remotes 按给的值配 */
function repo(remotes: Record<string, string | { url: string; push?: string }>): string {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  for (const [name, v] of Object.entries(remotes)) {
    const { url, push } = typeof v === "string" ? { url: v, push: undefined } : v;
    git(dir, "remote", "add", name, url);
    if (push) git(dir, "remote", "set-url", "--push", name, push);
  }
  return dir;
}

const remoteUrl = (dir: string, name: string) => git(dir, "config", "--local", `remote.${name}.url`);
const configBytes = (dir: string) => readFileSync(join(dir, ".git", "config"), "utf8");
const recordPath = (dir: string) => join(dir, ".git", "floka-repo-migration.json");

async function cli(dir: string, ...args: string[]) {
  const r = await runRepoCli(["--repo", dir, ...args]);
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

/** observe → 计划落文件 → on */
async function migrate(dir: string) {
  const obs = await cli(dir, "--mode", "observe");
  expect(obs.code).toBe(0);
  const planFile = join(tmp(), "plan.json");
  writeFileSync(planFile, obs.stdout);
  return { obs, planFile, on: await cli(dir, "--mode", "on", "--plan", planFile) };
}

const OLD = OFFICIAL_REPO;
const NEW = PROPOSED_REPO;

describe("url 口径", () => {
  test("四种官方形状都认、改写保持协议 / 端口 / .git", () => {
    const cases: [string, string][] = [
      [`https://github.com/${OLD}.git`, `https://github.com/${NEW}.git`],
      [`https://github.com/${OLD}`, `https://github.com/${NEW}`],
      [`git@github.com:${OLD}.git`, `git@github.com:${NEW}.git`],
      [`git@github.com:${OLD}`, `git@github.com:${NEW}`],
      [`ssh://git@github.com/${OLD}.git`, `ssh://git@github.com/${NEW}.git`],
      [`ssh://git@ssh.github.com:443/${OLD}.git`, `ssh://git@ssh.github.com:443/${NEW}.git`],
    ];
    for (const [from, to] of cases) {
      expect(isOfficialUrl(from, OLD)).toBe(true);
      expect(rewriteOfficialUrl(from, OLD, NEW)).toBe(to);
    }
  });

  test("fork / 带凭据 / 尾斜杠 / 大小写不同 / 别的主机都不是官方地址", () => {
    for (const u of [
      "https://github.com/someone/claudestra.git", "https://tok@github.com/shawnlu96/claudestra.git", "https://github.com/shawnlu96/claudestra/",
      "https://github.com/Shawnlu96/claudestra.git", "https://gitlab.com/shawnlu96/claudestra.git", " https://github.com/shawnlu96/claudestra.git",
      "/srv/mirror/claudestra.git", "https://github.com/shawnlu96/claudestra-relay.git",
    ]) expect(isOfficialUrl(u, OLD)).toBe(false);
    expect(parseOfficialShape("https://github.com/shawnlu96/claudestra.git.git")).toBeNull();
  });
});

describe("[验收线 1] 临时 Git 仓迁移与恢复", () => {
  for (const [label, url, expected] of [
    ["HTTPS", `https://github.com/${OLD}.git`, `https://github.com/${NEW}.git`],
    ["SSH", `git@github.com:${OLD}.git`, `git@github.com:${NEW}.git`],
    ["SSH 443 无 .git", `ssh://git@ssh.github.com:443/${OLD}`, `ssh://git@ssh.github.com:443/${NEW}`],
  ] as const) {
    test(`${label} 官方 origin 迁到新地址、按记录恢复;fork 与额外 remote 不变`, async () => {
      const dir = repo({ origin: url, upstream: `https://github.com/${OLD}.git`, fork: "git@github.com:someone/claudestra.git", mirror: "/srv/mirror/claudestra.git" });
      const before = { upstream: remoteUrl(dir, "upstream"), fork: remoteUrl(dir, "fork"), mirror: remoteUrl(dir, "mirror") };
      const { obs, on } = await migrate(dir);
      expect(obs.json.plan.changes).toEqual([{ remote: "origin", key: "url", from: url, to: expected }]);
      expect(obs.json.plan.untouched.map((u: { remote: string }) => u.remote).sort()).toEqual(["fork", "mirror", "upstream"]);
      expect(on.code).toBe(0);
      expect(on.json.status).toBe("applied");
      expect(remoteUrl(dir, "origin")).toBe(expected);
      expect({ upstream: remoteUrl(dir, "upstream"), fork: remoteUrl(dir, "fork"), mirror: remoteUrl(dir, "mirror") }).toEqual(before);
      const rec = JSON.parse(readFileSync(recordPath(dir), "utf8")) as MigrationRecord;
      expect(rec.status).toBe("applied");
      expect(rec.changes[0].from).toBe(url);

      const back = await cli(dir, "--mode", "on", "--rollback");
      expect(back.code).toBe(0);
      expect(back.json.status).toBe("rolled-back");
      expect(back.json.githubUntouched).toBe(true);
      expect(remoteUrl(dir, "origin")).toBe(url);
      expect({ upstream: remoteUrl(dir, "upstream"), fork: remoteUrl(dir, "fork"), mirror: remoteUrl(dir, "mirror") }).toEqual(before);
      // 再回滚一次是空操作
      const cfg = configBytes(dir);
      expect((await cli(dir, "--mode", "on", "--rollback")).json.status).toBe("rolled-back");
      expect(configBytes(dir)).toBe(cfg);
    });
  }

  test("origin 的 pushurl 也是官方地址就一起迁、各自保持协议", async () => {
    const dir = repo({ origin: { url: `https://github.com/${OLD}.git`, push: `git@github.com:${OLD}.git` } });
    const { on } = await migrate(dir);
    expect(on.json.status).toBe("applied");
    expect(remoteUrl(dir, "origin")).toBe(`https://github.com/${NEW}.git`);
    expect(git(dir, "config", "--local", "remote.origin.pushurl")).toBe(`git@github.com:${NEW}.git`);
    await cli(dir, "--mode", "on", "--rollback");
    expect(remoteUrl(dir, "origin")).toBe(`https://github.com/${OLD}.git`);
    expect(git(dir, "config", "--local", "remote.origin.pushurl")).toBe(`git@github.com:${OLD}.git`);
  });

  test("origin 是 fork / 自定义 / 带凭据地址:计划为空,on 一字不写", async () => {
    for (const url of ["git@github.com:someone/claudestra.git", "https://tok@github.com/shawnlu96/claudestra.git", "https://git.example.com/claudestra.git"]) {
      const dir = repo({ origin: url, extra: `https://github.com/${OLD}.git` });
      const cfg = configBytes(dir);
      const { obs, on } = await migrate(dir);
      expect(obs.json.plan.changes).toEqual([]);
      expect(on.json.status).toBe("applied");
      expect(configBytes(dir)).toBe(cfg);
      expect(existsSync(recordPath(dir))).toBe(false);
    }
  });

  test("迁移后 origin 被人改过:回滚拒绝覆盖", async () => {
    const dir = repo({ origin: `https://github.com/${OLD}.git` });
    await migrate(dir);
    git(dir, "remote", "set-url", "origin", "https://git.example.com/elsewhere.git");
    const back = await cli(dir, "--mode", "on", "--rollback");
    expect(back.code).toBe(1);
    expect(back.json.status).toBe("blocked");
    expect(remoteUrl(dir, "origin")).toBe("https://git.example.com/elsewhere.git");
  });
});

/** 记下每次调用的 fake RepoGit */
function fakeGit(remotes = [{ name: "origin", urls: [`https://github.com/${OLD}.git`], pushUrls: [] as string[] }]) {
  const calls: string[] = [];
  const port: RepoGit = {
    async listRemotes() { calls.push("list"); return remotes.map((r) => ({ ...r, urls: [...r.urls], pushUrls: [...r.pushUrls] })); },
    async setUrl(remote, key, from, to) {
      calls.push(`set ${remote}.${key}`);
      const r = remotes.find((x) => x.name === remote)!;
      const vals = key === "url" ? r.urls : r.pushUrls;
      vals[vals.indexOf(from)] = to;
    },
  };
  return { port, calls, remotes };
}
function memRecords(): RecordStore & { saved: MigrationRecord[] } {
  const saved: MigrationRecord[] = [];
  return { saved, load: async () => saved.at(-1) ?? null, save: async (r) => { saved.push(r); } };
}

describe("[验收线 2] off / observe 零 Git 写入;源 remote 变化拒绝旧计划", () => {
  test("off(缺省与不认识的值)一次 git 都不调;observe 只读", async () => {
    for (const mode of [undefined, "off", "ON", "yes"]) {
      const f = fakeGit(); const rec = memRecords();
      expect((await planRepoMigration({ mode, git: f.port })).status).toBe("off");
      expect((await applyRepoMigration({ mode, git: f.port, records: rec, plan: {} })).status).toBe("off");
      expect((await rollbackRepoMigration({ mode, git: f.port, records: rec })).status).toBe("off");
      expect(f.calls).toEqual([]);
      expect(rec.saved).toEqual([]);
    }
    const f = fakeGit(); const rec = memRecords();
    const plan = (await planRepoMigration({ mode: "observe", git: f.port })).plan!;
    expect((await applyRepoMigration({ mode: "observe", git: f.port, records: rec, plan })).status).toBe("observed");
    expect(f.calls.every((c) => c === "list")).toBe(true);
    expect(rec.saved).toEqual([]);
    expect(plan.prerequisites.length).toBeGreaterThan(0);
    expect(plan.prerequisites.every((p) => p.status === "manual")).toBe(true);
  });

  test("真实临时仓:off / observe 前后 .git 逐字节不变、不落记录;off 不要求是 git 仓", async () => {
    const dir = repo({ origin: `git@github.com:${OLD}.git` });
    const cfg = configBytes(dir);
    const off = await cli(dir);
    expect(off.json.status).toBe("off");
    const obs = await cli(dir, "--mode", "observe");
    expect(obs.json.status).toBe("observed");
    const planFile = join(tmp(), "plan.json");
    writeFileSync(planFile, obs.stdout);
    expect((await cli(dir, "--mode", "observe", "--rollback")).json.status).toBe("blocked"); // 没有记录:只报告
    expect(configBytes(dir)).toBe(cfg);
    expect(existsSync(recordPath(dir))).toBe(false);
    expect((await cli(join(tmp(), "nope"))).json).toMatchObject({ status: "off" });
  });

  test("observe 之后 remote 变了(加 remote / 改 origin):on 拒绝旧计划,一字不写", async () => {
    for (const mutate of [
      (d: string) => git(d, "remote", "add", "extra", "https://git.example.com/x.git"),
      (d: string) => git(d, "remote", "set-url", "origin", `git@github.com:${OLD}.git`),
    ]) {
      const dir = repo({ origin: `https://github.com/${OLD}.git` });
      const obs = await cli(dir, "--mode", "observe");
      const planFile = join(tmp(), "plan.json");
      writeFileSync(planFile, obs.stdout);
      mutate(dir);
      const cfg = configBytes(dir);
      const on = await cli(dir, "--mode", "on", "--plan", planFile);
      expect(on.code).toBe(1);
      expect(on.json.status).toBe("blocked");
      expect(on.json.refusals.join()).toContain("旧计划作废");
      expect(configBytes(dir)).toBe(cfg);
      expect(existsSync(recordPath(dir))).toBe(false);
    }
  });

  test("计划被改过(换目标 / 换 changes)拒绝;目标是 cloud 私仓拒绝", async () => {
    const f = fakeGit(); const rec = memRecords();
    const plan = buildRepoPlan(await f.port.listRemotes());
    for (const bad of [{ ...plan, to: "evil/x" }, { ...plan, changes: [] }]) {
      const r = await applyRepoMigration({ mode: "on", git: f.port, records: rec, plan: bad });
      expect(r.status).toBe("blocked");
    }
    const cloud = buildRepoPlan(await f.port.listRemotes(), OLD, PRIVATE_CLOUD_REPO);
    expect(cloud.refusals.join()).toContain("cloud");
    expect(cloud.changes).toEqual([]);
    expect((await applyRepoMigration({ mode: "on", git: f.port, records: rec, plan: cloud })).status).toBe("blocked");
    expect(f.calls.filter((c) => c.startsWith("set"))).toEqual([]);
    expect(rec.saved).toEqual([]);
  });

  test("已有未回滚的记录:再迁拒绝;写之前先落原值", async () => {
    const f = fakeGit(); const rec = memRecords();
    const plan = buildRepoPlan(await f.port.listRemotes());
    expect((await applyRepoMigration({ mode: "on", git: f.port, records: rec, plan })).status).toBe("applied");
    expect(rec.saved.map((r) => r.status)).toEqual(["applying", "applied"]);
    expect((await applyRepoMigration({ mode: "on", git: f.port, records: rec, plan })).status).toBe("blocked");
  });

  test("origin 多个 url 值:不猜,计划带拒绝", () => {
    const plan = buildRepoPlan([{ name: "origin", urls: [`https://github.com/${OLD}.git`, `git@github.com:${OLD}.git`], pushUrls: [] }]);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals.length).toBe(1);
  });

  test("fileRecordStore 原子写、读回", async () => {
    const p = join(tmp(), "r.json");
    const s = fileRecordStore(p);
    expect(await s.load()).toBeNull();
    const r: MigrationRecord = { version: 1, item: "rename.repo", planKey: "k", from: OLD, to: NEW, changes: [], status: "applied" };
    await s.save(r);
    expect(await s.load()).toEqual(r);
  });
});

const INSTALL_SH = readFileSync(join(ROOT, "install.sh"), "utf8");

/** install.sh 里认仓库的那一行,原样拿出来在 bash 里跑 */
function installSlug(url: string): string {
  const line = INSTALL_SH.split("\n").find((l) => l.includes("GITHUB_API_REPO=$("))!.trim();
  const p = Bun.spawnSync(["bash", "-c", `CLAUDESTRA_REPO="$1"; ${line}; printf '%s' "$GITHUB_API_REPO"`, "_", url], { stdout: "pipe" });
  return p.stdout.toString();
}

/** fake 下载环境:git clone 从本地源仓拉、把 origin 设成给的地址;curl 只记 URL 回一份 release JSON */
function fakeInstallEnv() {
  const base = tmp("floka-install-");
  const bin = join(base, "bin");
  mkdirSync(bin);
  const src = join(base, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  mkdirSync(join(src, "src"));
  writeFileSync(join(src, "src", "setup.ts"), "export const SETUP_CONTRACT = 2;\n");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  git(src, "tag", "v9.9.9");
  const realGit = Bun.which("git")!;
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("git", `if [ "$1" = clone ]; then "${realGit}" clone -q "${src}" "$3" && "${realGit}" -C "$3" remote set-url origin "$2"; exit $?; fi\nexec "${realGit}" "$@"`);
  stub("curl", `for a; do last="$a"; done\nprintf '%s\\n' "$last" >> "${base}/curl.log"\nprintf '{"tag_name": "v9.9.9"}'`);
  for (const n of ["brew", "apt-get", "tmux", "node", "npm", "claude", "bun", "bunx", "npx"]) stub(n, "exit 0");
  return { base, bin, curlLog: join(base, "curl.log") };
}

function runInstall(env: ReturnType<typeof fakeInstallEnv>, repoUrl: string, dir: string) {
  const p = Bun.spawnSync(["bash", join(ROOT, "install.sh")], {
    stdout: "pipe", stderr: "pipe",
    env: { ...ENV, PATH: `${env.bin}:/usr/bin:/bin`, HOME: env.base, CLAUDESTRA_REPO: repoUrl, CLAUDESTRA_DIR: dir, CLAUDESTRA_YES: "1", CLAUDESTRA_NO_SETUP: "1", CLAUDESTRA_LANG: "en" },
  });
  if (p.exitCode !== 0) throw new Error(`install.sh exit ${p.exitCode}: ${p.stdout.toString()}\n${p.stderr.toString()}`);
}

function fakeFetch() {
  const urls: string[] = [];
  const f = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ tag_name: "v9.9.9", name: "v9.9.9", body: "" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

describe("[验收线 3] 安装地址与 origin 更新器解析一致;cwd / worktree 不动", () => {
  test("install.sh 缺省地址就是官方仓;sed 与更新器对同一组地址逐条同义", () => {
    expect(INSTALL_SH).toContain(`CLAUDESTRA_REPO="\${CLAUDESTRA_REPO:-${installDefaultUrl()}}"`);
    for (const u of [
      installDefaultUrl(), installDefaultUrl(NEW), `https://github.com/${NEW}`, `git@github.com:${NEW}.git`, `git@github.com:${NEW}`,
      `ssh://git@github.com/${NEW}.git`, `ssh://git@ssh.github.com:443/${NEW}.git`, `https://tok@github.com/${NEW}.git`, "https://git.example.com/a/b.git",
      "https://github.com/owner/repo.name.git",
    ]) expect(installSlug(u)).toBe(releaseSlugOf(u) ?? "");
  });

  test("fake 下载:新地址安装与更新器查的是同一个 release API", async () => {
    const env = fakeInstallEnv();
    for (const url of [installDefaultUrl(NEW), `git@github.com:${NEW}`]) {
      const dir = join(env.base, `install-${roots.length}-${url.length}`);
      rmSync(env.curlLog, { force: true });
      runInstall(env, url, dir);
      const curled = readFileSync(env.curlLog, "utf8").trim().split("\n");
      expect(curled).toEqual([releaseApiUrl(NEW)]);
      expect(git(dir, "remote", "get-url", "origin")).toBe(url);
      expect(await getGitHubRepo(dir)).toBe(NEW);
      const ff = fakeFetch();
      expect((await getLatestRelease({ cwd: dir, fetchImpl: ff.f }))?.tag).toBe("v9.9.9");
      expect(ff.urls).toEqual(curled);
    }
  });

  test("旧官方地址安装 → 迁 origin 后更新器跟到新仓;cwd / worktree / hooks 路径不变", async () => {
    const env = fakeInstallEnv();
    const dir = join(env.base, "claudestra");
    runInstall(env, `git@github.com:${OLD}.git`, dir);
    git(dir, "config", "core.hooksPath", ".githooks");
    const wt = join(env.base, "wt");
    git(dir, "worktree", "add", "-q", "--detach", wt);
    const snap = () => ({
      cwd: process.cwd(), top: git(dir, "rev-parse", "--show-toplevel"), wtTop: git(wt, "rev-parse", "--show-toplevel"),
      worktrees: git(dir, "worktree", "list", "--porcelain"), head: git(dir, "rev-parse", "HEAD"), status: git(dir, "status", "--porcelain"),
      hooks: git(dir, "config", "core.hooksPath"),
    });
    const before = snap();
    const ff0 = fakeFetch();
    await getLatestRelease({ cwd: dir, fetchImpl: ff0.f });
    expect(ff0.urls).toEqual([releaseApiUrl(OLD)]);

    // 从 worktree 里跑也只改共用的 origin;记录在公共 git 目录
    const { on } = await migrate(wt);
    expect(on.json.status).toBe("applied");
    expect(git(dir, "remote", "get-url", "origin")).toBe(`git@github.com:${NEW}.git`);
    expect(snap()).toEqual(before);

    rmSync(env.curlLog, { force: true });
    runInstall(env, installDefaultUrl(NEW), join(env.base, "fresh"));
    const ff = fakeFetch();
    await getLatestRelease({ cwd: dir, fetchImpl: ff.f });
    expect(ff.urls).toEqual(readFileSync(env.curlLog, "utf8").trim().split("\n"));

    expect((await cli(wt, "--mode", "on", "--rollback")).json.status).toBe("rolled-back");
    expect(git(dir, "remote", "get-url", "origin")).toBe(`git@github.com:${OLD}.git`);
    expect(snap()).toEqual(before);
  });
});

test("gitRepoPort 写是比较后交换:当前值不对就失败、不追加", async () => {
  const dir = repo({ origin: "https://git.example.com/a.git" });
  const cfg = configBytes(dir);
  await expect(gitRepoPort(dir).setUrl("origin", "url", `https://github.com/${OLD}.git`, `https://github.com/${NEW}.git`)).rejects.toThrow();
  expect(configBytes(dir)).toBe(cfg);
});

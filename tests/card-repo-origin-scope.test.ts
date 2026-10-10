/**
 * i28-SECPOOL2 r2：① 按 origin 找 clone 只认真正的 GitHub 主机（复用 order-deliver-pr.ts parseOriginRepo），
 * notgithub.com、路径里夹着 github.com 的 origin 不当成私仓 clone；② 私仓卡的交付范围 diff 在它自己仓库的 clone 里读，
 * 不再去公共仓 fetch 私仓对象——范围外文件照旧登记、范围内不登记。全程本地 git，不联网。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOriginRepo, privateStart, repoDirFor, type RepoDirIO } from "../src/lib/card-repo.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { cardScopeDiff, ensureDeliverScope } from "../src/lib/order-deliver-scope.js";
import type { ScopeRun } from "../src/lib/order-deliver-scope-git.js";

const PRIV = "floka-ai/cloud";
let root: string, db: Database, ledger: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "card-repo-origin-")); });
afterEach(() => { if (ledger) closeLedger(ledger); rmSync(root, { recursive: true, force: true }); });

const git = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
function repo(name: string, origin: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", origin);
  return dir;
}
const io = (dirs: string[]): RepoDirIO => ({ dirs: () => dirs, origin: gitOriginRepo, exists: existsSync });

test("origin 只认 github.com 主机：非 GitHub 主机 / 路径里夹 github.com 不算私仓 clone，privateStart 报缺 clone", () => {
  const fake = repo("fake", "https://notgithub.com/floka-ai/cloud.git");
  const nested = repo("nested", "https://evil.example/github.com/floka-ai/cloud.git");
  const ssh = repo("ssh", "git@github.com:floka-ai/cloud.git");
  const https = repo("https", "https://github.com/Floka-AI/cloud");
  expect(gitOriginRepo(fake)).toBeNull();
  expect(gitOriginRepo(nested)).toBeNull();
  expect(gitOriginRepo(ssh)).toBe(PRIV);
  expect(gitOriginRepo(https)).toBe("Floka-AI/cloud");
  expect(repoDirFor("p", PRIV, io([fake, nested]))).toBeNull();
  expect(privateStart("p", [`repo:${PRIV}/src/a.ts`], "on", io([fake, nested]))).toEqual({ repo: PRIV, dir: null });
  // 无关目录排在真实 clone 前面也不会被选中
  expect(repoDirFor("p", PRIV, io([fake, nested, ssh, https]))).toBe(ssh);
});

test("私仓卡的交付范围在私仓 clone 里读 diff：范围外文件登记，范围内不登记；公共仓 clone 里没有私仓对象也不受影响", async () => {
  const pub = repo("pub", "https://github.com/shawnlu96/claudestra.git");
  writeFileSync(join(pub, "README.md"), "pub\n"); git(pub, "add", "."); git(pub, "commit", "-qm", "pub");
  const priv = repo("priv", `https://github.com/${PRIV}.git`);
  mkdirSync(join(priv, "src"));
  writeFileSync(join(priv, "src/inside.ts"), "a\n"); git(priv, "add", "."); git(priv, "commit", "-qm", "base");
  const base = git(priv, "rev-parse", "HEAD");
  writeFileSync(join(priv, "src/inside.ts"), "a\nb\n"); writeFileSync(join(priv, "outside.ts"), "x\n");
  git(priv, "add", "."); git(priv, "commit", "-qm", "head");
  const head = git(priv, "rev-parse", "HEAD");

  ledger = join(root, "ledger.db"); db = openLedger(ledger);
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "P1", project: "p", title: "私仓", kind: "code", extra: { fileGlobs: [`repo:${PRIV}/src/*.ts`], repo: PRIV } });
  db.run("UPDATE tasks SET stage = 'review', round = 1, headSHA = ?, pr = ? WHERE id = 'P1'", [head, `https://github.com/${PRIV}/pull/7`]);

  const cwds: string[] = [];
  const run = (dir: string): ScopeRun => async (cmd, args) => {
    cwds.push(dir);
    if (cmd === "gh") {
      expect(args).toEqual(["pr", "view", "7", "--repo", PRIV, "--json", "baseRefOid,headRefOid"]);
      return JSON.stringify({ baseRefOid: base, headRefOid: head });
    }
    const r = Bun.spawnSync([cmd, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${cmd} ${args[0]} 失败`);
    return r.stdout.toString();
  };
  const dirFor = (project: string, ownerName: string) => repoDirFor(project, ownerName, io([pub, priv]));
  await ensureDeliverScope(db, getTask(db, "P1")!, head, (d, t, h) => cardScopeDiff(d, t, h, { dirFor, run }));
  const ev = listEvents(db, { target: "P1" }).find((e) => e.data.op === "deliver_scope");
  expect(ev?.data.files).toEqual([{ path: "outside.ts", added: 1, deleted: 0, sharedWith: [] }]);
  expect(new Set(cwds)).toEqual(new Set([priv]));

  // 项目 dirs 里没有私仓 clone：不去公共仓读，按「未能登记」记原因
  await expect(cardScopeDiff(db, getTask(db, "P1")!, head, { dirFor: () => null, run })).rejects.toThrow(`项目 dirs 里没有 ${PRIV} 的 clone`);
});

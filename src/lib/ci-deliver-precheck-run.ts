/**
 * merge-arch-CIPRECHK1 · 交付前预检的真实端口（ci-deliver-precheck.ts 的 PrecheckPort）：git 读绑定事实，按 CI 责任选集同一口径
 * （mode=on，base 侧 = 合并基的树，head 侧 = 工作副本）选测，选测与登记检查都经 ci-impact-registration-check.ts 的 treeImpact；
 * 测试经工作副本的 scripts/test.ts（全量测试闸入口）只带文件起，输出收进管道，不污染 manager 的 JSON 输出。
 * 本机没有 CI 的实测读取图（CI_IO_MAP 工件），按登记表规则选；结果缓存在状态目录 ci-deliver-precheck/<绑定摘要>.json。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_FILE, treeImpact, type TreeImpactInput } from "./ci-impact-registration-check.js";
import type { Inspection, PrecheckPort, PrecheckReceipt, TestRun } from "./ci-deliver-precheck.js";
import { FULL_TEST_PERMIT_ENV } from "./full-test-gate-args.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const TEST_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 30;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")}：${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString();
}
const nul = (s: string) => s.split("\0").filter(Boolean);

/** 合并基那棵树里的模块源码：一次 cat-file --batch 读完（逐个 git show 上千次太慢）；路径带换行的退回单读 */
function blobsAt(root: string, rev: string, paths: readonly string[]): Map<string, string> {
  const want = paths.filter((p) => MODULE_FILE.test(p) && !p.includes("\n"));
  const r = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root, stdin: Buffer.from(want.map((p) => `${rev}:${p}\n`).join("")), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git cat-file：${r.stderr.toString().trim().slice(0, 200)}`);
  const out = r.stdout, map = new Map<string, string>();
  let at = 0;
  for (const p of want) {
    const nl = out.indexOf(10, at);
    const [, kind, size] = out.subarray(at, nl).toString().split(" ");
    if (kind !== "blob") throw new Error(`合并基里读不到 ${p}`);
    const n = Number(size);
    map.set(p, out.subarray(nl + 1, nl + 1 + n).toString("utf8"));
    at = nl + 1 + n + 1;
  }
  return map;
}

function gitFacts(worktree: string) {
  const root = git(worktree, "rev-parse", "--show-toplevel").trim();
  const head = git(root, "rev-parse", "HEAD").trim();
  const base = ["origin/main", "main"].map((r) => {
    try { return git(root, "rev-parse", "--verify", "-q", `${r}^{commit}`).trim(); }
    catch { return ""; /* 这个名字不存在就试下一个：出借副本只有 origin/main，本机工作树可能只有 main */ }
  }).find(Boolean);
  if (!base) throw new Error("找不到 origin/main 或 main，无法对 main 求 diff");
  let repo = "（无 origin）";
  try { repo = git(root, "remote", "get-url", "origin").trim(); } catch { /* 没有 origin 远端：绑定里记成占位，前后两次照样可比 */ }
  return { root, head, base, repo, mergeBase: git(root, "merge-base", base, head).trim(), status: git(root, "status", "--porcelain=v1", "-z", "--untracked-files=no") };
}

async function inspectOnce(worktree: string, memo: Map<string, Inspection>): Promise<Inspection | { error: string } | { skip: string }> {
  try {
    const f = gitFacts(worktree);
    const memoKey = JSON.stringify([f.root, f.head, f.base, f.repo, f.mergeBase, f.status]);
    const hit = memo.get(memoKey);
    if (hit) return hit; // 同一份 git 事实 + 干净工作区 = 同一棵树，选测是它的纯函数
    if (!existsSync(join(f.root, "scripts", "ci-related-plan.ts"))) return { skip: "交付的仓库没有 CI 选测计划（scripts/ci-related-plan.ts，别的项目），不适用" };
    const { parseSync } = await import("oxc-parser");
    const headPaths = nul(git(f.root, "ls-files", "-z"));
    const basePaths = nul(git(f.root, "ls-tree", "-r", "-z", "--name-only", f.mergeBase));
    const baseBlobs = blobsAt(f.root, f.mergeBase, basePaths);
    const { sel, changedTests, registration } = treeImpact({ headPaths, basePaths, parseSync: parseSync as unknown as TreeImpactInput["parseSync"],
      readHead: (p) => readFileSync(join(f.root, p), "utf8"), readBase: (p) => baseBlobs.get(p) ?? git(f.root, "show", `${f.mergeBase}:${p}`),
      nameStatus: git(f.root, "diff", "-z", "--name-status", "-M", f.mergeBase, f.head) });
    const selection = `${sel.digest}:${Bun.hash(JSON.stringify([changedTests, registration])).toString(16)}`;
    const ins: Inspection = { binding: { repo: f.repo, base: f.base, mergeBase: f.mergeBase, head: f.head, status: f.status, selection },
      run: sel.run === "selected" ? "selected" : "all", tests: sel.tests, reasons: sel.fullReasons, changedTests, registration };
    memo.set(memoKey, ins);
    return ins;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const tailOf = (text: string) => text.split("\n").filter((l) => l.trim()).slice(-TAIL_LINES).map((l) => l.slice(0, 200)).join("\n");

/** 只带文件经 scripts/test.ts 起：全量测试闸按「带文件」放行（不占全量名额），也绝不会因空参数变成全量 */
async function runTests(worktree: string, files: string[]): Promise<TestRun> {
  if (!files.length) throw new Error("预检不起不带文件的测试");
  const root = git(worktree, "rev-parse", "--show-toplevel").trim();
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[FULL_TEST_PERMIT_ENV]; // 本进程若自己就在测试闸放行的子进程里，别把那张许可带给新的一次运行
  const proc = Bun.spawn([process.execPath, "scripts/test.ts", ...files.map((f) => `./${f}`)], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGTERM"), TEST_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, tail: code === 0 ? "" : tailOf(`${out}\n${err}`) };
  } finally { clearTimeout(timer); }
}

const cachePath = (key: string) => statePath("ci-deliver-precheck", `${key}.json`);

export function realPrecheckPort(): PrecheckPort {
  const memo = new Map<string, Inspection>();
  return {
    inspect: (worktree) => inspectOnce(worktree, memo),
    runTests,
    recall: (key) => {
      if (!/^[0-9a-f]{64}$/.test(key)) return null;
      const r = readJsonStateSync(cachePath(key));
      const v = r.status === "ok" ? (r.data as PrecheckReceipt) : null;
      return v && v.ok === true && v.key === key && Array.isArray(v.ran) ? v : null;
    },
    remember: (key, receipt) => {
      try { writeJsonAtomicSync(cachePath(key), receipt, { mode: 0o600 }); }
      catch (e) { console.error(`[ciDeliverPrecheck] 写预检缓存失败（下次重跑一遍，不影响本次结果）：${String(e)}`); }
    },
  };
}

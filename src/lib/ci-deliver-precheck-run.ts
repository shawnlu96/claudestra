/**
 * merge-arch-CIPRECHK1 · 交付前预检的真实端口（ci-deliver-precheck.ts 的 PrecheckPort）：git 读绑定事实，按 CI 责任选集同一口径
 * （mode=on，base 侧 = base 的树，head 侧 = base 与交付 head 的合并树，同 scripts/ci-related-plan.ts prSelect 的合并提交）选测，
 * 选测与登记检查都经 ci-impact-registration-check.ts 的 treeImpact，登记表用合并树自己的那份（REGISTRY_FILE；CI 读的就是检出树的那份）；
 * 未跟踪文件（不含忽略的）按内容进绑定；合不出（冲突）= 无法执行，拒交。
 * 测试经 scripts/test.ts（全量测试闸入口）只带文件起，输出收进管道，不污染 manager 的 JSON 输出：head 已含 base 就在工作副本里跑；
 * 没含就在合并提交（第一父 base、第二父 head）的临时 worktree 里跑 CI 那棵树的完整选集，跑完删掉。
 * 本机没有 CI 的实测读取图（CI_IO_MAP 工件），按登记表规则选；结果缓存在状态目录 ci-deliver-precheck/<绑定摘要>.json。
 * bridge 入口的后台预检是本文件自己（`bun ci-deliver-precheck-run.ts job <副本> <head> <事实键>`），结果与锁在 ci-deliver-precheck/jobs/；
 * 锁是 file-lock.ts，由后台进程自己抢（抢不到 = 已有人在跑同一份事实，直接退出），起进程的一方不持锁；
 * 后台进程开跑前、写回执前都核对事实键（回执带它实际绑定的事实），写前核租；取回时再按当前事实核一次。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_FILE, REGISTRY_FILE, type RegistryInputs, treeImpact, type TreeImpactInput } from "./ci-impact-registration-check.js";
import type { BackgroundState, Inspection, MergeTarget, PrecheckBinding, PrecheckPort, PrecheckReceipt, TestRun } from "./ci-deliver-precheck.js";
import { acquireLock } from "./file-lock.js";
import { FULL_TEST_PERMIT_ENV } from "./full-test-gate-args.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/** 选集超过这么多个测试文件（或选测给 all）就降级：只跑改动测试 + 登记检查 */
export const PRECHECK_MAX_TESTS = 50;

const bindingKey = (b: PrecheckBinding): string =>
  createHash("sha256").update(JSON.stringify(["v3", PRECHECK_MAX_TESTS, b.repo, b.base, b.mergeBase, b.head, b.status, b.untracked, b.selection])).digest("hex");

/** 工作副本事实（不含选测图）的摘要：后台回执带它，事实键由它算 */
type Facts = Pick<PrecheckBinding, "repo" | "base" | "mergeBase" | "head" | "status" | "untracked">;
const factsDigest = (b: Facts): string =>
  createHash("sha256").update(JSON.stringify(["facts-v1", b.repo, b.base, b.mergeBase, b.head, b.status, b.untracked])).digest("hex");

/** 跑什么：有界选集照跑；只有超阈值或 all 才降级为改动测试，原规模与原因进回执 */
export function planRun(ins: Inspection): { scope: PrecheckReceipt["scope"]; files: string[]; selected: number | "all"; degradeReasons: string[] } {
  if (ins.run === "selected" && ins.tests.length <= PRECHECK_MAX_TESTS) return { scope: "selected", files: ins.tests, selected: ins.tests.length, degradeReasons: [] };
  const why = ins.run === "all" ? `选测给出 all：${ins.reasons.slice(0, 5).join("；") || "（无原因）"}` : `选集 ${ins.tests.length} 个测试文件，超过阈值 ${PRECHECK_MAX_TESTS}`;
  return { scope: "degraded", files: ins.changedTests, selected: ins.run === "all" ? "all" : ins.tests.length,
    degradeReasons: [why, "只跑本次新增 / 修改的测试 + 登记检查，不算完整相关测试通过"] };
}

const DRIFT: [keyof PrecheckBinding, string][] = [["repo", "仓库"], ["base", "base"], ["mergeBase", "合并基"], ["head", "head"], ["status", "工作区"],
  ["untracked", "未跟踪文件"], ["selection", "选测图摘要"]];

export const fail = (failures: string[], key = ""): PrecheckReceipt => ({ ok: false, scope: "selected", selected: 0, ran: [], degradeReasons: [], failures, key, reused: false });

/** 预检本体：绑定 → 选测 / 登记 → 跑测试 → 再绑定核对；相同绑定的通过结果直接复用 */
export async function runPrecheck(worktree: string, head: string, port: PrecheckPort): Promise<PrecheckReceipt> {
  const ins = await port.inspect(worktree);
  if ("error" in ins) return fail([`无法执行预检：${ins.error}`]);
  if ("skip" in ins) return { ...fail([]), ok: true, skipped: ins.skip };
  if (!ins.binding.head.startsWith(head.toLowerCase()) || head.length < 7) return fail([`工作副本 HEAD ${ins.binding.head.slice(0, 12)} 不是交付 head ${head.slice(0, 12)}（在交付的工作副本里运行）`]);
  if (ins.binding.status) return fail(["工作副本有未提交的已跟踪改动：先提交干净再交付"]);
  const key = bindingKey(ins.binding), facts = factsDigest(ins.binding);
  const prior = port.recall(key);
  if (prior?.ok && prior.key === key) return { ...prior, reused: true, facts };
  const plan = planRun(ins);
  const failures = ins.registration.map((r) => `登记检查：${r}`);
  if (plan.files.length) {
    const r = await port.runTests(worktree, plan.files, ins.merge);
    if (r.code !== 0) failures.push(`相关测试失败（退出码 ${r.code}，${plan.files.length} 个文件）${r.tail ? `：\n${r.tail}` : ""}`);
  }
  const after = await port.inspect(worktree);
  if (!("binding" in after)) failures.push(`跑完后无法重新核对工作副本：${"error" in after ? after.error : after.skip}`);
  else for (const [k, what] of DRIFT) if (after.binding[k] !== ins.binding[k]) failures.push(`预检期间${what}变了，结果作废，重新交付`);
  const receipt: PrecheckReceipt = { ok: !failures.length, scope: plan.scope, selected: plan.selected, ran: plan.files, degradeReasons: plan.degradeReasons,
    failures, key, reused: false, facts };
  if (receipt.ok) port.remember(key, receipt);
  return receipt;
}

const TEST_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 30;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")}：${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString();
}
const nul = (s: string) => s.split("\0").filter(Boolean);

/** 某棵树里的模块源码：一次 cat-file --batch 读完（逐个 git show 上千次太慢）；路径带换行的退回单读 */
function blobsAt(root: string, rev: string, paths: readonly string[]): Map<string, string> {
  const want = paths.filter((p) => MODULE_FILE.test(p) && !p.includes("\n"));
  const r = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root, stdin: Buffer.from(want.map((p) => `${rev}:${p}\n`).join("")), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git cat-file：${r.stderr.toString().trim().slice(0, 200)}`);
  const out = r.stdout, map = new Map<string, string>();
  let at = 0;
  for (const p of want) {
    const nl = out.indexOf(10, at);
    const [, kind, size] = out.subarray(at, nl).toString().split(" ");
    if (kind !== "blob") throw new Error(`${rev.slice(0, 12)} 里读不到 ${p}`);
    const n = Number(size);
    map.set(p, out.subarray(nl + 1, nl + 1 + n).toString("utf8"));
    at = nl + 1 + n + 1;
  }
  return map;
}

/** 对 main 求 diff 的基线：出借写单副本只有 refs/remotes/origin/HEAD（lend-clone.ts 取的订单 base 分支，已核实），排第一；
 *  普通克隆的 origin/HEAD 就是指向默认分支的符号引用；再退到 origin/main、main（本机工作树可能只有 main） */
const BASE_REFS = ["refs/remotes/origin/HEAD", "origin/main", "main"];

/** 未跟踪（不含忽略的）文件的路径与内容摘要：它们会影响测试读取、目录扫描与模块解析，进绑定，变了就不复用、跑的期间变了就作废 */
function untrackedDigest(root: string): string {
  const paths = nul(git(root, "ls-files", "-z", "--others", "--exclude-standard")).sort();
  if (!paths.length) return "";
  const h = createHash("sha256");
  for (const p of paths) {
    h.update(p).update("\0");
    try { h.update(readFileSync(join(root, p))); } catch (e) { h.update(`!${(e as NodeJS.ErrnoException).code ?? "read"}`); /* 读不了（目录软链 / 权限）：记下读不了本身 */ }
    h.update("\0");
  }
  return `${paths.length}:${h.digest("hex")}`;
}

function gitFacts(worktree: string) {
  const root = git(worktree, "rev-parse", "--show-toplevel").trim();
  const head = git(root, "rev-parse", "HEAD").trim();
  const base = BASE_REFS.map((r) => {
    try { return git(root, "rev-parse", "--verify", "-q", `${r}^{commit}`).trim(); }
    catch { return ""; /* 这个名字不存在就试下一个 */ }
  }).find(Boolean);
  if (!base) throw new Error("找不到 origin/HEAD、origin/main 或 main，无法对 main 求 diff");
  let repo = "（无 origin）";
  try { repo = git(root, "remote", "get-url", "origin").trim(); } catch { /* 没有 origin 远端：绑定里记成占位，前后两次照样可比 */ }
  return { root, head, base, repo, mergeBase: git(root, "merge-base", base, head).trim(), status: git(root, "status", "--porcelain=v1", "-z", "--untracked-files=no"),
    untracked: untrackedDigest(root) };
}

/** CI 测的是 PR 的合并提交（第一父 = 当前 base）：同一棵合并树在本机用 merge-tree 算（不动工作区）；head 已含 base 就是 head 自己的树。
 *  合并有冲突（CI 也合不出）：无法执行，抛出（调用方拒交），不降级 */
function mergedTree(root: string, base: string, head: string): string {
  if (Bun.spawnSync(["git", "merge-base", "--is-ancestor", base, head], { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode === 0)
    return git(root, "rev-parse", `${head}^{tree}`).trim();
  const r = Bun.spawnSync(["git", "merge-tree", "--write-tree", "--no-messages", base, head], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const tree = r.stdout.toString().split("\n")[0]!.trim();
  if (r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(tree)) return tree;
  if (r.exitCode === 1) throw new Error(`交付 head 与 base ${base.slice(0, 12)} 合并有冲突（CI 同样合不出）：先解决冲突再交付`);
  throw new Error(`git merge-tree 算不出合并树：${r.stderr.toString().trim().slice(0, 200)}`);
}

const inputsMemo = new Map<string, RegistryInputs>();
/** 交付树自己的登记表：CI 在检出的合并树里 import 这份文件，本机就取同一个 blob，在临时目录的子进程里求值（不在 manager 进程里 import 交付的代码） */
function treeInputs(root: string, tree: string): RegistryInputs {
  let oid: string;
  try { oid = git(root, "rev-parse", "--verify", "-q", `${tree}:${REGISTRY_FILE}`).trim(); }
  catch { throw new Error(`交付树里没有 ${REGISTRY_FILE}，无从按它的登记表选测`); }
  const hit = inputsMemo.get(oid);
  if (hit) return hit;
  const dir = mkdtempSync(join(tmpdir(), "ci-deliver-precheck-inputs-"));
  try {
    writeFileSync(join(dir, "registry.ts"), git(root, "cat-file", "blob", oid));
    writeFileSync(join(dir, "dump.ts"), `import { DEFAULT_IMPACT_INPUTS } from "./registry.ts";\nprocess.stdout.write(JSON.stringify(DEFAULT_IMPACT_INPUTS));\n`);
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "dump.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`交付树的 ${REGISTRY_FILE} 求值失败：${r.stderr.toString().trim().slice(-200)}`);
    const v = JSON.parse(r.stdout.toString()) as RegistryInputs;
    for (const k of ["fullTriggers", "alwaysRun", "inputMap", "implicit", "knownUnresolved", "docs"] as const)
      if (!Array.isArray(v?.[k])) throw new Error(`交付树的 ${REGISTRY_FILE} 缺 ${k}，与本机选测不兼容`);
    inputsMemo.set(oid, v);
    return v;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function inspectOnce(worktree: string, memo: Map<string, Inspection>): Promise<Inspection | { error: string } | { skip: string }> {
  try {
    const f = gitFacts(worktree);
    const memoKey = JSON.stringify([f.root, f.head, f.base, f.repo, f.mergeBase, f.status, f.untracked]);
    const hit = memo.get(memoKey);
    if (hit) return hit; // 同一份 git 事实 + 干净工作区 = 同一棵树，选测是它的纯函数
    if (!existsSync(join(f.root, "scripts", "ci-related-plan.ts"))) return { skip: "交付的仓库没有 CI 选测计划（scripts/ci-related-plan.ts，别的项目），不适用" };
    const { parseSync } = await import("oxc-parser");
    const from = f.base, to = mergedTree(f.root, f.base, f.head);
    const pathsAt = (rev: string) => nul(git(f.root, "ls-tree", "-r", "-z", "--name-only", rev));
    const reader = (rev: string, paths: string[]) => {
      const blobs = blobsAt(f.root, rev, paths);
      return (p: string) => blobs.get(p) ?? git(f.root, "show", `${rev}:${p}`);
    };
    const headPaths = pathsAt(to), basePaths = pathsAt(from);
    const { sel, changedTests, registration } = treeImpact({ headPaths, basePaths, parseSync: parseSync as unknown as TreeImpactInput["parseSync"],
      readHead: reader(to, headPaths), readBase: reader(from, basePaths), nameStatus: git(f.root, "diff", "-z", "--name-status", "-M", from, to),
      inputs: treeInputs(f.root, to) });
    // head 没含 base：选集是合并树的（可能有 main 自分叉后新增的测试），测试就在这棵合并树里跑，不在工作副本里跑
    const merge = to === git(f.root, "rev-parse", `${f.head}^{tree}`).trim() ? undefined : { tree: to, base: f.base, head: f.head };
    const selection = `${to}:${sel.digest}:${Bun.hash(JSON.stringify([changedTests, registration])).toString(16)}`;
    const ins: Inspection = { binding: { repo: f.repo, base: f.base, mergeBase: f.mergeBase, head: f.head, status: f.status, untracked: f.untracked, selection },
      run: sel.run === "selected" ? "selected" : "all", tests: sel.tests, reasons: sel.fullReasons, changedTests, registration, ...(merge ? { merge } : {}) };
    memo.set(memoKey, ins);
    return ins;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const tailOf = (text: string) => text.split("\n").filter((l) => l.trim()).slice(-TAIL_LINES).map((l) => l.slice(0, 200)).join("\n");

/** CI 的合并提交检出到临时 worktree（作者 / 时间固定，同一对 base/head 得同一个提交）；依赖目录软链工作副本已装好的 node_modules（根和一级子目录） */
function checkoutMerge(root: string, m: MergeTarget): { dir: string; dispose: () => void } {
  const id = { GIT_AUTHOR_NAME: "ci-deliver-precheck", GIT_AUTHOR_EMAIL: "precheck@localhost", GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z" };
  const r = Bun.spawnSync(["git", "commit-tree", m.tree, "-p", m.base, "-p", m.head, "-m", "ci-deliver-precheck merge"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...id, GIT_COMMITTER_NAME: id.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: id.GIT_AUTHOR_EMAIL, GIT_COMMITTER_DATE: id.GIT_AUTHOR_DATE } });
  if (r.exitCode !== 0) throw new Error(`git commit-tree：${r.stderr.toString().trim().slice(0, 200)}`);
  const dir = mkdtempSync(join(tmpdir(), "ci-deliver-precheck-merge-"));
  const dispose = () => {
    Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: root, stdout: "ignore", stderr: "ignore" });
    rmSync(dir, { recursive: true, force: true });
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  };
  try {
    git(root, "worktree", "add", "-q", "--detach", dir, r.stdout.toString().trim());
    for (const sub of ["", ...readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".git" && e.name !== "node_modules").map((e) => e.name)]) {
      const from = join(root, sub, "node_modules"), to = join(dir, sub, "node_modules");
      if (existsSync(from) && existsSync(join(dir, sub)) && !existsSync(to)) symlinkSync(from, to, "dir");
    }
  } catch (e) { dispose(); throw e; }
  return { dir, dispose };
}

/** 只带文件经 scripts/test.ts 起：全量测试闸按「带文件」放行（不占全量名额），也绝不会因空参数变成全量；给了 merge 就在合并树的临时检出里跑 */
async function runTests(worktree: string, files: string[], merge?: MergeTarget): Promise<TestRun> {
  if (!files.length) throw new Error("预检不起不带文件的测试");
  const top = git(worktree, "rev-parse", "--show-toplevel").trim();
  const at = merge ? checkoutMerge(top, merge) : null;
  try { return await runTestsIn(at?.dir ?? top, files); } finally { at?.dispose(); }
}

async function runTestsIn(root: string, files: string[]): Promise<TestRun> {
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
const jobPath = (key: string, ext: "json" | "lock") => statePath("ci-deliver-precheck", "jobs", `${key}.${ext}`);
const jobKey = (root: string, head: string, facts: string) => createHash("sha256").update(JSON.stringify(["job-v3", root, head, facts])).digest("hex");

/** 后台预检的事实核对：current = 工作副本此刻的事实键（读不到 = null）；keyOf = 回执实际绑定的事实对应的事实键（回执没带事实 = null） */
export interface JobFacts { current(): string | null; keyOf(r: PrecheckReceipt): string | null }
export function realJobFacts(worktree: string, head: string): JobFacts {
  let root: string | undefined;
  return {
    current: () => {
      try { const f = gitFacts(worktree); root = f.root; return jobKey(f.root, head, factsDigest(f)); } catch { return null; /* 副本读不了：对不上任何键 */ }
    },
    keyOf: (r) => {
      if (!r.facts) return null;
      try { root ??= git(worktree, "rev-parse", "--show-toplevel").trim(); } catch { return null; }
      return jobKey(root, head, r.facts);
    },
  };
}

/** 后台预检持锁期间按 1/3 续租；进程没了，过了这么久没续就可回收 */
export const JOB_LOCK_STALE_MS = 60_000;

/** 锁目录在且最近续过租 = 有人在跑（含刚抢到、还没写 owner 的初始化窗口）：不再起进程 */
function lockFresh(lock: string): boolean {
  try { return Date.now() - statSync(lock).mtimeMs <= JOB_LOCK_STALE_MS; } catch { return false; /* 没有锁 */ }
}

async function background(worktree: string, head: string): Promise<BackgroundState> {
  let key: string;
  try { const f = gitFacts(worktree); key = jobKey(f.root, head, factsDigest(f)); } catch (e) { return { error: (e as Error).message }; }
  const done = readJsonStateSync(jobPath(key, "json"));
  if (done.status === "ok") {
    const receipt = done.data as PrecheckReceipt;
    const bound = receipt.facts ? realJobFacts(worktree, head).keyOf(receipt) === key : true;
    if (!receipt.ok || !bound) unlinkSync(jobPath(key, "json")); // 失败只报一次：修好之前每次重交都重跑；绑的不是当前事实的回执作废、重跑
    if (bound) return { state: "done", receipt };
  }
  if (lockFresh(jobPath(key, "lock"))) return { state: "running" };
  mkdirSync(dirname(jobPath(key, "lock")), { recursive: true, mode: 0o700 });
  // 起进程的一方不持锁：两个交付同时走到这里最多多起一个进程，它抢不到锁（或抢到时结果已在）就直接退出，预检本体只跑一次
  const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(import.meta.url), "job", worktree, head, key],
    { cwd: worktree, env: process.env, stdio: ["ignore", "ignore", "ignore"], detached: true });
  child.unref();
  return { state: "running" };
}

/** 后台预检进程：抢 file-lock（不等），抢到后结果已在就不重跑；开跑前事实已不是这个键就不跑；跑完回执绑的事实对得上这个键、
 *  且锁仍是自己的（held 核租）才写到事实键下，再按 token 放锁（不删别人的锁）。没写 = 下次交付按当时的事实另起 */
export async function runJob(worktree: string, head: string, key: string, precheck: () => Promise<PrecheckReceipt> = () => runPrecheck(worktree, head, realPrecheckPort()),
  facts: JobFacts = realJobFacts(worktree, head)): Promise<boolean> {
  mkdirSync(dirname(jobPath(key, "lock")), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(jobPath(key, "lock"), 0, JOB_LOCK_STALE_MS);
  if (!lock) return false;
  try {
    if (readJsonStateSync(jobPath(key, "json")).status === "ok") return false;
    if (facts.current() !== key) return false;
    const receipt = await precheck();
    if ((receipt.facts ? facts.keyOf(receipt) : facts.current()) !== key) return false;
    if (!lock.held()) return false;
    writeJsonAtomicSync(jobPath(key, "json"), receipt, { mode: 0o600 });
    return true;
  } finally { lock.release(); }
}

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
    background,
  };
}

if (import.meta.main && process.argv[2] === "job") {
  const [worktree, head, key] = process.argv.slice(3);
  if (worktree && head && key && /^[0-9a-f]{64}$/.test(key)) await runJob(worktree, head, key);
}

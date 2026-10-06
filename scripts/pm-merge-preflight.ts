/**
 * MAINP2 验收线 5 / 8：PM 手动合并的正规 preflight 与合入后核对端口。gh / git 全是结构化 argv，不经 shell、不用管道；
 * 必需 CI 取卡所在项目的正式配置（scheduler.json requiredChecks），不由命令行定义。用法、退出码与薄接线提案见 USAGE（--help）。
 * tests/pm-merge-preflight*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getTask } from "../src/lib/ledger-store.js";
import { verifyMergedCarry, type VerifyReport } from "../src/lib/review-main-carry-manual-verify.js";
import { reviewMainCarryProof, type MainCarryInput } from "../src/lib/review-main-carry-proof.js";
import { ghJson, headChecks, type CheckState, type Run } from "../src/lib/review-main-carry-manual-ci.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseRequiredChecks, readSchedulerConfig } from "../src/lib/scheduler-config.js";

export const USAGE = `用法：
  bun scripts/pm-merge-preflight.ts --task <卡号> --pr <PR URL> --expected-head <sha> --actual-main <sha>
    [--reviewed-head <sha> --repo-dir <dir>]  head 不是审过的 head：本地 fetch 后独立跑 canonical 多跳证明（≤16 跳纯 main）
    [--update-branch]                         钉 expected head 更新分支；等 PR head 真的变成新 head（202 只是受理）、新 head 的必需 run 出现后按新 head 检查
    [--merge]                                 过闸后再核一遍，sha=<最终 head> 原子钉住合并（GitHub 对变了的 head 回 409）
    [--step '<JSON argv>' ...]                合并成功后依次执行（ff / deploy 等），任何一步非 0 立即停并以该步 exit 退出
  bun scripts/pm-merge-preflight.ts verify --task <卡号> --repo-dir <dir>   合入后只读核对（LedgerReader + GitHub 现查 + 每条沿用重跑证明 + 部署记录）
必需 CI：卡所在项目 scheduler.json 的 requiredChecks（--task 读台账定项目，并核卡的 PR 就是 --pr）；不收 --checks。
退出码：0 通过 / 已合并且各步成功 / 核对一致；2 拒绝（head / main 漂移、证明不成立、CI 失败 / 取消 / skipped / 缺、核对不一致）；
  3 等待（CI 未完成、新 head 或新 run 没出现）；4 合并未确认；5 合并后某一步非 0（写明哪步与原 exit，之后不跑，stage live 只能在 exit 0 之后由 PM 做）。
薄接线提案（PM 合后接进既有 card-merge / merge-queue；不含私有地址）：
  1) 合并前：head 有纯 main 合并时先 \`ledger main-carry <task> ...\` → 本脚本不带 --merge 跑一次，exit 0 才继续；
  2) 合并：本脚本带 --merge（替换不钉 head 的合并调用）；
  3) ff / deploy：作为 --step 依次传入，不用 \`| tail\` 吞原 exit；exit 0 后才 stage live；
  4) 合入后：本脚本 verify --task <task> --repo-dir <dir>。`;

export { headChecks, type Run };
export type Prove = (input: MainCarryInput) => Promise<{ ok: boolean; reason: string }>;
const SHA = /^[a-f0-9]{40}$/;
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

export type Verdict = { ok: true; detail: string } | { ok: false; exit: 2 | 3 | 4; reason: string };
const refuse = (reason: string): Verdict => ({ ok: false, exit: 2, reason });
const wait = (reason: string): Verdict => ({ ok: false, exit: 3, reason });

const json = ghJson;

function parsePr(url: string): { repo: string; number: string } {
  const m = PR.exec(url);
  if (!m) throw new Error("PR URL 不合法");
  return { repo: m[1]!, number: m[2]! };
}

function ciVerdict(states: Record<string, CheckState>): Verdict {
  const list = Object.entries(states), by = (s: CheckState) => list.filter(([, v]) => v === s).map(([k]) => k);
  for (const s of ["fail", "cancelled", "skipped", "unknown"] as const) if (by(s).length) return refuse(`CI ${s}：${by(s).join(", ")}`);
  if (by("missing").length) return refuse(`当前 head 缺 CI run：${by("missing").join(", ")}`);
  if (by("pending").length) return wait(`CI 未完成：${by("pending").join(", ")}`);
  return { ok: true, detail: `CI 全绿：${list.map(([k]) => k).join(", ")}` };
}

export interface PreflightInput { pr: string; expectedHead: string; actualMain: string; checks: readonly string[]; reviewedHead?: string; repoDir?: string }

/** The card's project policy decides the required checks: no list from the command line, no duplicates, nothing empty. */
export function requiredChecksFor(db: Database | null, taskId: string, pr: string, checksOf: (project: string) => unknown): string[] {
  if (!db) throw new Error("台账读不了（LedgerReader 没有可读库）");
  const task = getTask(db, taskId);
  if (!task) throw new Error(`台账没有 ${taskId}`);
  if (task.pr !== pr) throw new Error(`${taskId} 的 PR 是 ${task.pr ?? "空"}，不是 ${pr}`);
  const raw = checksOf(task.project), list = parseRequiredChecks(raw);
  if (!list || !Array.isArray(raw) || list.length !== raw.length) throw new Error(`项目 ${task.project} 的 requiredChecks 缺失、为空或有重复`);
  return list;
}

/** Final head, actual main, independent carry proof (when the head moved), required CI on that very head — in that order. */
export async function preflight(input: PreflightInput, run: Run, prove: Prove = reviewMainCarryProof): Promise<Verdict> {
  const { repo } = parsePr(input.pr);
  if (!SHA.test(input.expectedHead) || !SHA.test(input.actualMain)) return refuse("expected head / actual main 要是完整小写 SHA");
  if (!input.checks.length || input.checks.some((c) => !c.trim()) || new Set(input.checks).size !== input.checks.length) return refuse("必需 CI 清单为空或有重复");
  const pr = await json(run, ["gh", "pr", "view", input.pr, "--json", "state,headRefOid,baseRefName,isDraft,isCrossRepository"], "gh pr view") as Record<string, unknown>;
  if (pr.state !== "OPEN" || pr.baseRefName !== "main" || pr.isDraft !== false || pr.isCrossRepository !== false) return refuse(`PR 状态不对：${String(pr.state)}/${String(pr.baseRefName)}`);
  if (pr.headRefOid !== input.expectedHead) return refuse(`PR head 已漂移：${String(pr.headRefOid).slice(0, 12)}`);
  const main = await json(run, ["gh", "api", `repos/${repo}/git/ref/heads/main`], "gh main ref") as { object?: { sha?: unknown } };
  if (main.object?.sha !== input.actualMain) return refuse(`actual main 已漂移：${String(main.object?.sha).slice(0, 12)}`);
  if (input.reviewedHead && input.reviewedHead !== input.expectedHead) {
    if (!input.repoDir || !SHA.test(input.reviewedHead)) return refuse("head 动过：要 --reviewed-head 完整 SHA 与 --repo-dir 跑独立证明");
    const f = await run(["git", "fetch", "--no-tags", "--quiet", "origin", input.expectedHead, "+refs/heads/main:refs/remotes/origin/main"],
      { cwd: input.repoDir, timeoutMs: 120_000 });
    if (f.timedOut || f.code !== 0) return refuse(`git fetch 失败：exit ${f.code ?? "timeout"}`);
    let proof: { ok: boolean; reason: string };
    try {
      proof = await prove({ repoDir: input.repoDir, repository: repo, base: "main", mainHead: input.actualMain, oldHead: input.reviewedHead, newHead: input.expectedHead });
    } catch (e) { return refuse(`证明读取失败：${(e as Error).message.slice(0, 200)}`); }
    if (!proof.ok) return refuse(`纯 main 合并证明不成立：${proof.reason}`);
  }
  return ciVerdict(await headChecks(run, repo, input.expectedHead, input.checks));
}

/** After update-branch: wait until every required check has a run on the new head; a run that never appears is not green. */
export async function waitForHeadRuns(run: Run, repo: string, head: string, names: readonly string[],
  o: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<"present" | "timeout"> {
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now = o.now ?? Date.now, end = now() + o.timeoutMs;
  for (;;) {
    const states = await headChecks(run, repo, head, names);
    if (Object.values(states).every((s) => s !== "missing")) return "present";
    if (now() >= end) return "timeout";
    await sleep(o.intervalMs);
  }
}

/**
 * Head-pinned update. GitHub answers 202 when it only accepted the job, so the new head is the PR head once it has left
 * `expectedHead` — polled, bounded; until then (or if it never moves) there is no new head to judge and nothing merges.
 */
export async function updateBranch(run: Run, prUrl: string, expectedHead: string,
  o: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<string | "timeout"> {
  const { repo, number } = parsePr(prUrl);
  await json(run, ["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHead}`], "gh update-branch");
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now = o.now ?? Date.now, end = now() + o.timeoutMs;
  for (;;) {
    const pr = await json(run, ["gh", "pr", "view", prUrl, "--json", "headRefOid"], "gh pr view") as { headRefOid?: unknown };
    if (typeof pr.headRefOid !== "string" || !SHA.test(pr.headRefOid)) throw new Error("更新后读不到 PR head");
    if (pr.headRefOid !== expectedHead) return pr.headRefOid;
    if (now() >= end) return "timeout";
    await sleep(o.intervalMs);
  }
}

/** The merge itself: sha-pinned REST merge, confirmed merged with a full SHA. */
export async function pinnedMerge(run: Run, prUrl: string, expectedHead: string): Promise<Verdict & { sha?: string }> {
  const { repo, number } = parsePr(prUrl);
  const r = await json(run, ["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${number}/merge`, "-f", `sha=${expectedHead}`, "-f", "merge_method=merge"], "gh merge API")
    .catch((e: Error) => ({ error: e.message }));
  const m = r as { merged?: unknown; sha?: unknown; error?: string };
  if (m.merged !== true || typeof m.sha !== "string" || !SHA.test(m.sha)) return { ok: false, exit: 4, reason: `GitHub 未确认合并：${m.error ?? "merged≠true"}` };
  return { ok: true, detail: `已合并 ${m.sha}`, sha: m.sha };
}

/** Each step runs on its own; the first non-zero (or timeout) stops the rest and its own exit code is returned. */
export async function runStrict(run: Run, steps: readonly string[][], cwd?: string): Promise<{ ok: true } | { ok: false; step: number; argv: string[]; code: number }> {
  for (const [i, argv] of steps.entries()) {
    if (!argv.length || argv.some((a) => typeof a !== "string")) return { ok: false, step: i, argv: [...argv], code: 2 };
    const r = await run(argv, { cwd, timeoutMs: 30 * 60_000 });
    if (r.timedOut || r.code !== 0) return { ok: false, step: i, argv: [...argv], code: r.code && r.code > 0 ? r.code : 1 };
  }
  return { ok: true };
}

export interface CliResult { exit: number; lines: string[] }
export interface CliDeps {
  run?: Run; prove?: Prove; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** read-only ledger (LedgerReader query_only); tests hand a temporary one */
  ledger?: () => Database | null;
  checksOf?: (project: string) => unknown;
  deployConfigured?: (project: string) => boolean;
  verify?: typeof verifyMergedCarry;
}
const realLedger = (): Database | null => new LedgerReader().get();
const projectOf = (project: string) => readSchedulerConfig().projects[project];

function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string>; steps: string[][] } | string {
  const flags: Record<string, string> = {}, bools = new Set<string>(), steps: string[][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--merge" || a === "--update-branch") { bools.add(a.slice(2)); continue; }
    const v = argv[i + 1];
    if (!a.startsWith("--") || v === undefined) return `参数不对：${a}`;
    i++;
    if (a === "--checks") return "必需 CI 由卡所在项目的 requiredChecks 定，不收 --checks";
    if (a === "--step") {
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { return `--step 要是 JSON argv 数组：${v}`; }
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((x) => typeof x !== "string")) return `--step 要是非空字符串数组：${v}`;
      steps.push(parsed as string[]);
    } else flags[a.slice(2)] = v;
  }
  return { flags, bools, steps };
}

/** `verify`: GitHub facts read live, the ledger read-only, then lib/review-main-carry-manual-verify.ts decides. */
async function verifyCmd(flags: Record<string, string>, deps: CliDeps, run: Run): Promise<CliResult> {
  if (!flags.task || !flags["repo-dir"]) return { exit: 2, lines: ["verify 要 --task 与 --repo-dir"] };
  const db = (deps.ledger ?? realLedger)();
  const task = db ? getTask(db, flags.task) : null;
  if (!db || !task?.pr) return { exit: 2, lines: [`台账读不了或 ${flags.task} 没有 PR`] };
  const { repo } = parsePr(task.pr);
  const pr = await json(run, ["gh", "pr", "view", task.pr, "--json", "state,baseRefName,headRefOid,mergeCommit"], "gh pr view") as Record<string, unknown>;
  const mergeSha = typeof (pr.mergeCommit as { oid?: unknown } | null)?.oid === "string" ? (pr.mergeCommit as { oid: string }).oid : null;
  const main = await json(run, ["gh", "api", `repos/${repo}/git/ref/heads/main`], "gh main ref") as { object?: { sha?: unknown } };
  const actualMain = typeof main.object?.sha === "string" ? main.object.sha : "";
  let contains = false;
  if (mergeSha && SHA.test(mergeSha) && SHA.test(actualMain)) {
    const cmp = await json(run, ["gh", "api", `repos/${repo}/compare/${mergeSha}...${actualMain}`, "--jq", "{status: .status}"], "gh compare") as { status?: unknown };
    contains = cmp.status === "identical" || cmp.status === "ahead";
    const f = await run(["git", "fetch", "--no-tags", "--quiet", "origin", mergeSha, "+refs/heads/main:refs/remotes/origin/main"], { cwd: flags["repo-dir"], timeoutMs: 120_000 });
    if (f.timedOut || f.code !== 0) return { exit: 2, lines: [`git fetch 失败：exit ${f.code ?? "timeout"}`] };
  }
  const git = async (args: string[]) => { const r = await run(["git", ...args], { cwd: flags["repo-dir"], timeoutMs: 30_000 }); return { code: r.timedOut ? -1 : r.code ?? -1, stdout: r.stdout }; };
  const r: VerifyReport = await (deps.verify ?? verifyMergedCarry)(db, task.id, {
    pr: { state: String(pr.state), baseRefName: String(pr.baseRefName), headRefOid: String(pr.headRefOid), mergeSha }, actualMain, mainContainsMerge: contains,
  }, { repoDir: flags["repo-dir"], git, deployConfigured: (deps.deployConfigured ?? ((p) => projectOf(p)?.deploy !== undefined))(task.project) });
  return { exit: r.ok ? 0 : 2, lines: [JSON.stringify(r)] };
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  const run = deps.run ?? runBounded, lines: string[] = [];
  if (argv[0] === "--help") return { exit: 0, lines: [USAGE] };
  const verify = argv[0] === "verify";
  const parsed = parseArgs(verify ? argv.slice(1) : argv);
  if (typeof parsed === "string") return { exit: 2, lines: [parsed] };
  const { flags, bools, steps } = parsed;
  try {
    if (verify) return await verifyCmd(flags, deps, run);
    const need = ["task", "pr", "expected-head", "actual-main"].filter((k) => !flags[k]);
    if (need.length) return { exit: 2, lines: [`缺 --${need.join(" --")}`] };
    const checks = requiredChecksFor((deps.ledger ?? realLedger)(), flags.task!, flags.pr!, deps.checksOf ?? ((p) => projectOf(p)?.requiredChecks));
    let head = flags["expected-head"]!;
    const timing = { timeoutMs: 10 * 60_000, intervalMs: 15_000, sleep: deps.sleep, now: deps.now };
    if (bools.has("update-branch")) {
      const moved = await updateBranch(run, flags.pr!, head, timing);
      if (moved === "timeout") return { exit: 3, lines: [`更新分支已受理，但 PR head 仍是 ${head.slice(0, 12)}：新 head 不明，不合并`] };
      head = moved;
      lines.push(`已更新分支，新 head ${head}`);
      const seen = await waitForHeadRuns(run, parsePr(flags.pr!).repo, head, checks, timing);
      if (seen === "timeout") return { exit: 3, lines: [...lines, "新 head 的必需 CI run 还没出现，不能当绿"] };
    }
    // after an update the head always differs from the reviewed one, so the independent proof always runs
    const input = { pr: flags.pr!, expectedHead: head, actualMain: flags["actual-main"]!, checks,
      reviewedHead: bools.has("update-branch") ? flags["reviewed-head"] ?? flags["expected-head"] : flags["reviewed-head"], repoDir: flags["repo-dir"] };
    const v = await preflight(input, run, deps.prove);
    if (!v.ok) return { exit: v.exit, lines: [...lines, v.reason] };
    lines.push(v.detail);
    if (!bools.has("merge")) return { exit: 0, lines };
    const again = await preflight(input, run, deps.prove); // the last read right before the irreversible call
    if (!again.ok) return { exit: again.exit, lines: [...lines, `合并未发出：${again.reason}`] };
    const m = await pinnedMerge(run, flags.pr!, head);
    if (!m.ok) return { exit: m.exit, lines: [...lines, m.reason] };
    lines.push(m.detail);
    const s = await runStrict(run, steps, flags["repo-dir"]);
    if (!s.ok) return { exit: 5, lines: [...lines, `第 ${s.step + 1} 步 ${JSON.stringify(s.argv)} exit ${s.code}：已停，后续步骤与 stage live 都不做`] };
    return { exit: 0, lines: [...lines, `合并后 ${steps.length} 步全部 exit 0`] };
  } catch (e) {
    return { exit: 2, lines: [...lines, `失败（不当绿）：${(e as Error).message.slice(0, 300)}`] };
  }
}

if (import.meta.main) {
  const r = await main(process.argv.slice(2));
  for (const l of r.lines) (r.exit === 0 ? console.log : console.error)(l);
  process.exit(r.exit);
}

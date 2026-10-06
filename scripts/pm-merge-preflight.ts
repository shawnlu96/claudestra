/**
 * MAINP2 验收线 5：PM 手动合并的正规 preflight 端口。所有外部调用都是结构化 argv（gh / git），不经 shell、不用管道。
 *
 *   bun scripts/pm-merge-preflight.ts --pr <PR URL> --expected-head <sha> --actual-main <sha> --checks a,b,c,...
 *     [--reviewed-head <sha> --repo-dir <dir>]   新 head 不是审过的 head 时：本地 fetch 后独立跑 canonical 多跳证明（≤16 跳纯 main）
 *     [--update-branch]                          先钉 expected head 更新分支，等新 head 的必需 CI run 出现后按新 head 检查
 *     [--merge]                                  过闸后再核一遍，用 sha=<expected head> 原子钉住合并（GitHub 对变了的 head 回 409）
 *     [--step '<JSON argv>' ...]                 合并成功后依次执行（ff / deploy 等），任何一步非 0 立即停并以该步 exit 退出
 *
 * 退出码：0 通过 / 已合并且各步成功；2 拒绝（head / main 漂移、证明不成立、CI 失败 / 取消 / skipped / 缺）；3 等待（CI 未完成、新 run 没出现）；
 * 4 合并未确认；5 合并后某一步非 0（stderr 写明是哪步、原 exit），之后的步骤不跑——台账 stage live 只能在 exit 0 之后由 PM 自己做。
 * 失败不统一当「可重跑超时」：真实失败、取消、skipped、未知各自报出，只有 pending / run 未出现是 3。
 *
 * 薄接线提案（PM 合后接进既有 card-merge / merge-queue；不含任何私有地址）：
 *   1) 合并前：`ledger main-carry <task> ...`（head 有纯 main 合并时）→ 本脚本不带 --merge 跑一次，exit 0 才继续；
 *   2) 合并：本脚本带 --merge（替换现有不钉 head 的合并调用）；
 *   3) ff / deploy：作为 --step 依次传入，不再用 `| tail` 之类吞掉原 exit；exit 0 后才推 stage live；
 *   4) 合入后：`ledger main-carry-verify <task> --merged-head <head> --repo-dir <dir>`。
 * tests/pm-merge-preflight*.test.ts。
 */
import { reviewMainCarryProof, type MainCarryInput } from "../src/lib/review-main-carry-proof.js";
import { runBounded } from "../src/lib/run-bounded.js";

export type Run = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
export type Prove = (input: MainCarryInput) => Promise<{ ok: boolean; reason: string }>;
const SHA = /^[a-f0-9]{40}$/;
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

export type Verdict = { ok: true; detail: string } | { ok: false; exit: 2 | 3 | 4; reason: string };
const refuse = (reason: string): Verdict => ({ ok: false, exit: 2, reason });
const wait = (reason: string): Verdict => ({ ok: false, exit: 3, reason });

async function json(run: Run, argv: string[], what: string): Promise<unknown> {
  const r = await run(argv, { timeoutMs: 60_000 });
  if (r.timedOut || r.code !== 0) throw new Error(`${what} 失败：exit ${r.code ?? "timeout"} ${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
  try { return JSON.parse(r.stdout); } catch { throw new Error(`${what} 输出不是 JSON`); }
}

function parsePr(url: string): { repo: string; number: string } {
  const m = PR.exec(url);
  if (!m) throw new Error("PR URL 不合法");
  return { repo: m[1]!, number: m[2]! };
}

type CheckState = "pass" | "fail" | "cancelled" | "skipped" | "pending" | "missing" | "unknown";
/** Each required name's newest check run on exactly this head. Anything but completed+success is not green. */
export async function headChecks(run: Run, repo: string, head: string, names: readonly string[]): Promise<Record<string, CheckState>> {
  const raw = await json(run, ["gh", "api", `repos/${repo}/commits/${head}/check-runs?per_page=100`], "gh check-runs") as
    { total_count?: unknown; check_runs?: unknown };
  if (!Array.isArray(raw.check_runs) || typeof raw.total_count !== "number") throw new Error("check-runs 输出无效");
  if (raw.total_count > raw.check_runs.length) throw new Error("check-runs 超过一页，读不全"); // a truncated list never reads as green
  const runs = raw.check_runs as { id?: number; name?: string; head_sha?: string; status?: string; conclusion?: string | null }[];
  const out: Record<string, CheckState> = {};
  for (const name of names) {
    const mine = runs.filter((r) => r.name === name && r.head_sha === head).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const r = mine[0];
    out[name] = !r ? "missing" : r.status !== "completed" ? "pending"
      : r.conclusion === "success" ? "pass"
      : ["failure", "timed_out", "action_required", "startup_failure"].includes(String(r.conclusion)) ? "fail"
      : r.conclusion === "cancelled" ? "cancelled" : r.conclusion === "skipped" ? "skipped" : "unknown";
  }
  return out;
}

function ciVerdict(states: Record<string, CheckState>): Verdict {
  const list = Object.entries(states), by = (s: CheckState) => list.filter(([, v]) => v === s).map(([k]) => k);
  for (const s of ["fail", "cancelled", "skipped", "unknown"] as const) if (by(s).length) return refuse(`CI ${s}：${by(s).join(", ")}`);
  if (by("missing").length) return refuse(`当前 head 缺 CI run：${by("missing").join(", ")}`);
  if (by("pending").length) return wait(`CI 未完成：${by("pending").join(", ")}`);
  return { ok: true, detail: `CI 全绿：${list.map(([k]) => k).join(", ")}` };
}

export interface PreflightInput { pr: string; expectedHead: string; actualMain: string; checks: readonly string[]; reviewedHead?: string; repoDir?: string }

/** Final head, actual main, independent carry proof (when the head moved), required CI on that very head — in that order. */
export async function preflight(input: PreflightInput, run: Run, prove: Prove = reviewMainCarryProof): Promise<Verdict> {
  const { repo } = parsePr(input.pr);
  if (!SHA.test(input.expectedHead) || !SHA.test(input.actualMain)) return refuse("expected head / actual main 要是完整小写 SHA");
  if (!input.checks.length || input.checks.some((c) => !c.trim())) return refuse("--checks 不能为空");
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

/** Head-pinned update: GitHub refuses when the PR head is no longer `expectedHead`; returns the new head it produced. */
async function updateBranch(run: Run, prUrl: string, expectedHead: string): Promise<string> {
  const { repo, number } = parsePr(prUrl);
  await json(run, ["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHead}`], "gh update-branch");
  const pr = await json(run, ["gh", "pr", "view", prUrl, "--json", "headRefOid"], "gh pr view") as { headRefOid?: unknown };
  if (typeof pr.headRefOid !== "string" || !SHA.test(pr.headRefOid)) throw new Error("更新后读不到新 head");
  return pr.headRefOid;
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
export async function main(argv: string[], run: Run = runBounded, prove?: Prove): Promise<CliResult> {
  const flags: Record<string, string> = {}, bools = new Set<string>(), steps: string[][] = [], lines: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--merge" || a === "--update-branch") { bools.add(a.slice(2)); continue; }
    const v = argv[i + 1];
    if (!a.startsWith("--") || v === undefined) return { exit: 2, lines: [`参数不对：${a}`] };
    i++;
    if (a === "--step") {
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { return { exit: 2, lines: [`--step 要是 JSON argv 数组：${v}`] }; }
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((x) => typeof x !== "string")) return { exit: 2, lines: [`--step 要是非空字符串数组：${v}`] };
      steps.push(parsed as string[]);
    } else flags[a.slice(2)] = v;
  }
  const need = ["pr", "expected-head", "actual-main", "checks"].filter((k) => !flags[k]);
  if (need.length) return { exit: 2, lines: [`缺 --${need.join(" --")}`] };
  const checks = flags.checks!.split(",").map((s) => s.trim()).filter(Boolean);
  let head = flags["expected-head"]!;
  try {
    if (bools.has("update-branch")) {
      head = await updateBranch(run, flags.pr!, head);
      lines.push(`已更新分支，新 head ${head}`);
      const seen = await waitForHeadRuns(run, parsePr(flags.pr!).repo, head, checks, { timeoutMs: 10 * 60_000, intervalMs: 15_000 });
      if (seen === "timeout") return { exit: 3, lines: [...lines, "新 head 的必需 CI run 还没出现，不能当绿"] };
    }
    const input = { pr: flags.pr!, expectedHead: head, actualMain: flags["actual-main"]!, checks,
      reviewedHead: bools.has("update-branch") ? flags["reviewed-head"] ?? flags["expected-head"] : flags["reviewed-head"], repoDir: flags["repo-dir"] };
    const v = await preflight(input, run, prove);
    if (!v.ok) return { exit: v.exit, lines: [...lines, v.reason] };
    lines.push(v.detail);
    if (!bools.has("merge")) return { exit: 0, lines };
    const again = await preflight(input, run, prove); // the last read right before the irreversible call
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

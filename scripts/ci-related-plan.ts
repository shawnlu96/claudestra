// CI 选择计划（merge-arch-SELECT1，ci.yml 的 plan 作业）。用法：
//   bun scripts/ci-related-plan.ts plan <输出目录>             算本次运行的计划：写 <目录>/plan.json，scope / digest / mode 写进 $GITHUB_OUTPUT
//   bun scripts/ci-related-plan.ts files <plan.json> <digest> <k>   打印 related 计划第 k 片的文件（每行一个 ./路径；可以一行都没有）
// 模式来自受信的仓库变量 CI_RELATED_CHECKS（PR 改不了它），只在这里读一次：后面各作业只认 plan.json 与它的 digest，运行中切档改不了在跑的计划。
// 缺省 / 空 = observe（全量跑，只记拟选集）；off = 全量；on = 普通 PR 跑选集；其它值 = 全量（ci-impact-select.ts）。
// push（main）、列车临时 PR（train/ 分支）、workflow_dispatch 的补验永远全量；补验先核对检出的就是请求绑定的集成内容，对不上就失败。
// 选集同样排除慢清单（tests/slow-tests.txt）；排除后为空时整批改全量。tests/ci-related-workflow.test.ts。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync, tsconfigAliases } from "../src/lib/ci-impact-graph.js";
import { type ImpactSelection, parseNameStatus, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { fullRequestId } from "../src/lib/scheduler-ci-full-request.js";
import { loadDurations, parseSlowList, planShards, testFiles, withoutSlow } from "./ci-test-shard.ts";

export const SHARDS = 8;
export interface CiPlan {
  version: 1;
  event: string;
  sha: string;
  /** the raw CI_RELATED_CHECKS value as read once ("" = unset) */
  mode: string;
  scope: "full" | "related";
  /** why this run is full (empty for related) */
  reasons: string[];
  /** related: the selected tests minus the slow list; full: [] (the shard script's own full list applies) */
  tests: string[];
  shards: string[][];
  /** observe / on: how many tests the selector would have run, and out of how many */
  proposed: number | null;
  universe: number;
}

export const planDigest = (p: CiPlan): string => `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;

export interface PlanFacts {
  event: string;
  sha: string;
  mode: string;
  headRef: string;
  /** all tracked test files at the checkout and the slow list */
  allTests: string[];
  slow: string[];
  /** called only for an ordinary PR (never for push / train / dispatch / off) */
  select: (mode: unknown) => ImpactSelection;
  seconds: Readonly<Record<string, number>>;
}

const full = (f: PlanFacts, reasons: string[], proposed: number | null = null): CiPlan => ({ version: 1, event: f.event, sha: f.sha, mode: f.mode,
  scope: "full", reasons, tests: [], shards: Array.from({ length: SHARDS }, () => []), proposed, universe: f.allTests.length });

/** The one decision: full unless an ordinary PR under on gets a non-empty bounded selection. */
export function buildPlan(f: PlanFacts): CiPlan {
  if (f.event === "push") return full(f, ["push（main）始终全量"]);
  if (f.event === "workflow_dispatch") return full(f, ["串行补验始终全量"]);
  if (f.event !== "pull_request") return full(f, [`事件 ${f.event} 全量`]);
  if (f.headRef.startsWith("train/")) return full(f, ["列车 PR 始终全量"]);
  const sel = f.select(f.mode === "" ? undefined : f.mode);
  const proposed = sel.proposed ? withoutSlow(sel.proposed, f.slow).length : null;
  if (sel.run !== "selected") return full(f, sel.fullReasons.length ? sel.fullReasons : [`ciRelatedChecks=${sel.mode}，实际全量`], proposed);
  const tests = withoutSlow(sel.tests, f.slow);
  if (!tests.length) return full(f, ["排除慢清单后选集为空"], 0);
  return { version: 1, event: f.event, sha: f.sha, mode: f.mode, scope: "related", reasons: [], tests, shards: planShards(tests, SHARDS, f.seconds),
    proposed: tests.length, universe: f.allTests.length };
}

/** One line for the log and the step summary: what PM checks during observe. */
export function planLine(p: CiPlan, digest: string): string {
  const would = p.proposed === null ? "无拟选集" : `拟选 ${p.proposed} / ${p.universe}`;
  const why = p.reasons.length ? `；全量原因：${p.reasons.slice(0, 8).join("；")}` : "";
  return `CI 选择 mode=${p.mode || "(缺省 observe)"} event=${p.event} scope=${p.scope} · ${would} · 实跑 ${p.scope === "related" ? p.tests.length : "全量"}${why} · ${digest}`;
}

/** workflow_dispatch: the checkout must be exactly the request's merge commit of base + head, with its tree and id. */
export function dispatchProblems(env: Record<string, string | undefined>, git: (...a: string[]) => string): string[] {
  const want = { request: env.REQ_ID ?? "", pr: Number(env.REQ_PR), head: env.REQ_HEAD ?? "", base: env.REQ_BASE ?? "", merge: env.REQ_MERGE ?? "",
    tree: env.REQ_TREE ?? "", repo: env.GITHUB_REPOSITORY ?? "" };
  const out: string[] = [];
  const at = (rev: string) => { try { return git("rev-parse", rev).trim(); } catch { return "（读不到）"; } };
  const pairs: [string, string, string][] = [["HEAD", at("HEAD"), want.merge], ["HEAD^1", at("HEAD^1"), want.base], ["HEAD^2", at("HEAD^2"), want.head],
    ["HEAD^{tree}", at("HEAD^{tree}"), want.tree]];
  for (const [rev, got, exp] of pairs) if (got.toLowerCase() !== exp.toLowerCase()) out.push(`补验检出 ${rev}=${got}，请求绑定的是 ${exp || "（空）"}`);
  if (at("HEAD^3") !== "（读不到）") out.push("补验检出不是两个父提交的合并");
  const id = fullRequestId({ repo: want.repo, pr: want.pr, head: want.head, base: want.base, merge: want.merge, tree: want.tree });
  if (id !== want.request) out.push(`request_id ${want.request || "（空）"} 与绑定内容算出的 ${id} 不一致`);
  return out;
}

const run = (cwd: string) => (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}：${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString();
};

/** The selector over the PR's merge commit: changes = first parent → HEAD, base side read from a worktree of the first parent. */
function prSelect(root: string, tmp: string, headPaths: string[]): (mode: unknown) => ImpactSelection {
  const git = run(root), scan = oxcScanner(parseSync as unknown as OxcParseSync);
  return (mode) => {
    let changes: ReturnType<typeof parseNameStatus> = { changes: [], bad: ["读不到合并提交的改动"] };
    try { changes = parseNameStatus(git("diff", "-z", "--name-status", "-M", "HEAD^1", "HEAD")); }
    catch (e) { changes = { changes: [], bad: [`git diff 失败：${(e as Error).message}`] }; } // read as a full fallback reason below
    return selectImpactedTests({ mode, changes: changes.changes, badChanges: changes.bad, headPaths, load: () => {
      if (git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length !== 3) throw new Error("PR 检出不是合并提交");
      const baseDir = join(tmp, "ci-related-base");
      if (!existsSync(baseDir)) git("worktree", "add", "--detach", baseDir, "HEAD^1");
      const side = (dir: string, paths: string[]) => {
        const aliases = tsconfigAliases(readFileSync(join(dir, "tsconfig.json"), "utf8"));
        return { paths, graph: buildGraph({ paths, read: (p) => readFileSync(join(dir, p), "utf8") }, scan, aliases) };
      };
      const basePaths = run(baseDir)("ls-files", "-z").split("\0").filter(Boolean);
      return { base: side(baseDir, basePaths), head: side(root, headPaths) };
    } });
  };
}

function planMain(outDir: string | undefined): void {
  if (!outDir) throw new Error("plan 要一个输出目录");
  const env = process.env, root = join(import.meta.dir, ".."), git = run(root);
  const event = env.GITHUB_EVENT_NAME ?? "";
  if (event === "workflow_dispatch") {
    const bad = dispatchProblems(env, git);
    bad.forEach((e) => console.log(`::error::${e}`));
    if (bad.length) process.exit(1);
  }
  const headPaths = git("ls-files", "-z").split("\0").filter(Boolean), slowFile = join(root, "tests", "slow-tests.txt");
  const plan = buildPlan({ event, sha: git("rev-parse", "HEAD").trim(), mode: env.CI_RELATED_CHECKS ?? "", headRef: env.GITHUB_HEAD_REF ?? "",
    allTests: testFiles(headPaths.join("\n")), slow: existsSync(slowFile) ? parseSlowList(readFileSync(slowFile, "utf8")) : [],
    select: prSelect(root, env.RUNNER_TEMP ?? outDir, headPaths), seconds: loadDurations().seconds });
  const digest = planDigest(plan);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 1));
  const line = planLine(plan, digest);
  console.log(line);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `scope=${plan.scope}\ndigest=${digest}\nmode=${plan.mode || "observe"}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/** related plan → shard k's files; refuses a plan that is not the frozen one (digest) or not related. */
export function shardFiles(text: string, digest: string, k: number): string[] {
  const plan = JSON.parse(text) as CiPlan;
  if (planDigest(plan) !== digest) throw new Error(`plan.json 的 digest ${planDigest(plan)} 不是本次运行冻结的 ${digest}`);
  if (plan.scope !== "related") throw new Error("plan 不是 related，分片走全量清单");
  if (!Number.isSafeInteger(k) || k < 1 || k > plan.shards.length) throw new Error(`片号 ${k} 不合法`);
  return plan.shards[k - 1]!;
}

function main(args: string[]): void {
  if (args[0] === "plan") return planMain(args[1]);
  if (args[0] === "files") {
    const files = shardFiles(readFileSync(args[1] ?? "", "utf8"), args[2] ?? "", Number(args[3]));
    if (files.length) console.log(files.map((f) => `./${f}`).join("\n"));
    return;
  }
  throw new Error("用法：plan <目录> | files <plan.json> <digest> <k>");
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`ci-related-plan: ${(e as Error).message}`); process.exit(1); }
}

// CI 选择计划（merge-arch-SELECT1，ci.yml 的 plan 作业）。用法：
//   bun scripts/ci-related-plan.ts plan <输出目录>             算本次运行的计划：写 <目录>/plan.json，scope / digest / mode 写进 $GITHUB_OUTPUT
//   bun scripts/ci-related-plan.ts files <plan.json> <digest> <k>   打印 related 计划第 k 片的文件（每行一个 ./路径；可以一行都没有）
// 模式来自受信的仓库变量 CI_RELATED_CHECKS（PR 改不了它），只在这里读一次：后面各作业只认 plan.json 与它的 digest，运行中切档改不了在跑的计划。
// 缺省 / 空 = observe（全量跑，只记拟选集）；off = 全量；on = 普通 PR 跑选集；其它值 = 全量（ci-impact-select.ts）。
// push（main）、列车临时 PR（train/ 分支）、workflow_dispatch 的补验永远全量；补验先核对检出的就是请求绑定的集成内容，对不上就失败。
// 选集同样排除慢清单（tests/slow-tests.txt）；排除后为空时整批改全量。tests/ci-related-workflow.test.ts。
// 实测读取图（merge-arch-SELECT3，src/lib/ci-impact-io-map.ts）：受信仓库变量 CI_IO_MAP 同样只在这里读一次、冻结进 plan.json 的 ioMap。
// 缺省 / 空 = observe（实际跑什么照旧按上面的规则，另算一份「读取图会选 N」记进 plan.json 与日志）；on = 用读取图的选集；off = 不算。
// 图取自最近一次成功的 main push 运行（sha 是 PR head 的祖先）的 ci-io-map 工件；取不到、读不懂、超过 7 天都退回上面的规则并写明原因。
// tests/ci-impact-io-map.test.ts。
// 责任选集（merge-arch-CISEL1，src/lib/ci-selected-verdict.ts）：plan.json 另冻结 responsibility = 这张 PR 本该负责的测试，与执行范围
// （scope / tests / shards）分开算、互不影响。普通 PR（不论整次重跑、标签、light、CI_RELATED_CHECKS 哪一档）与属于某张 PR 的补验用同一选择器
// （CI_IO_MAP=on 时用读取图）在同一检出上按 on 口径算；任何兜底全量、push、列车、其它事件都记 "all"。tests/ci-related-plan-responsibility.test.ts。
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync, tsconfigAliases } from "../src/lib/ci-impact-graph.js";
import { ciIoMapMode, type IoMapResult, resolveIoMap, unionChanges } from "../src/lib/ci-impact-io-map.js";
import { type ImpactSelection, ciRelatedChecksMode, parseNameStatus, type SelectInput, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { selectLightTests, type LightSelection } from "../src/lib/ci-light-select.js";
import { type CiResponsibility, responsibility } from "../src/lib/ci-selected-verdict.js";
import { fullRequestId } from "../src/lib/scheduler-ci-full-request.js";
import { loadDurations, parseSlowList, planShards, testFiles, withoutSlow } from "./ci-test-shard.ts";

export const SHARDS = 8;
/** What the read map did for this plan (null = not computed: not an ordinary PR, either switch off, or no map source). */
export interface IoMapNote {
  /** the raw CI_IO_MAP value as read once ("" = unset) */
  mode: string;
  /** true = this plan's selection is the read map's (CI_IO_MAP=on and a usable map) */
  used: boolean;
  sha: string | null;
  generatedAt: string | null;
  /** what the read map's selection would run / picked before any fallback reason, slow list excluded (null = no usable map) */
  proposed: number | null;
  picked: number | null;
  /** why there is no usable map, or why the map's selection is the full suite */
  reasons: string[];
}
export interface CiPlan {
  version: 1;
  event: string;
  sha: string;
  /** the raw CI_RELATED_CHECKS value as read once ("" = unset) */
  mode: string;
  scope: "full" | "related" | "light";
  light?: LightSelection & { mode: string };
  queueMode?: string;
  /** why this run is full (empty for related) */
  reasons: string[];
  /** related: the selected tests minus the slow list; full: [] (the shard script's own full list applies) */
  tests: string[];
  shards: string[][];
  /** observe / on: how many tests the selector would have run, and out of how many (a fallback to full counts the whole list) */
  proposed: number | null;
  /** observe / on: how many tests the selector picked before any fallback reason sent the run full (slow list excluded); the log's 拟选 */
  picked: number | null;
  universe: number;
  ioMap?: IoMapNote | null;
  /**
   * pull_request only (merge-arch-SELECT4): the PR's own head, the second parent of the tested merge commit. `sha` is that synthetic
   * merge commit, so a later reader (src/lib/ci-io-map-fuse.ts) binds a plan to an exact PR head through this field, never through `sha`.
   */
  prHead?: string;
  /** merge-arch-CISEL1: the tests this PR is answerable for, frozen beside (never instead of) the execution fields above */
  responsibility?: CiResponsibility;
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
  /** the raw CI_IO_MAP value ("" = unset) and the read-map selection; called only for an ordinary PR whose two switches allow it */
  ioMode?: string;
  ioSelect?: (mode: unknown) => IoMapSelect;
  /** the PR's own head when the checkout is its merge commit (absent = unknown: the plan carries no binding) */
  prHead?: string;
  queueMode?: string;
  runAttempt?: number;
  labels?: readonly string[];
  lightSelect?: () => LightSelection;
  /** workflow_dispatch: the PR the full re-check belongs to (set only after its binding checked out); absent = no PR */
  dispatchPr?: number;
}
/** The selection over the read map; sel null = no usable map (reasons say why). */
export interface IoMapSelect { sel: ImpactSelection | null; sha: string | null; generatedAt: string | null; reasons: string[] }

type Extra = Pick<CiPlan, "proposed" | "picked" | "ioMap">;
const full = (f: PlanFacts, reasons: string[], x: Partial<Extra> = {}): CiPlan => ({ version: 1, event: f.event, sha: f.sha, mode: f.mode, scope: "full",
  reasons, tests: [], shards: Array.from({ length: SHARDS }, () => []), proposed: null, picked: null, universe: f.allTests.length, ...x });

/** proposed = what the selection would run; picked = what it reached before any fallback reason (links keep those); slow list excluded. */
function counts(sel: ImpactSelection, slow: readonly string[]): { proposed: number | null; picked: number | null } {
  if (!sel.proposed) return { proposed: null, picked: null };
  return { proposed: withoutSlow(sel.proposed, slow).length, picked: withoutSlow([...new Set(sel.links.map((l) => l.test))], slow).length };
}

/** The read map's part: nothing when either switch is off; otherwise its selection, used only under CI_IO_MAP=on with a usable map. */
function ioMapPart(f: PlanFacts, mode: unknown, cur: ImpactSelection): { ioMap?: IoMapNote; sel: ImpactSelection } {
  const raw = f.ioMode ?? "", io = ciIoMapMode(raw);
  if (!f.ioSelect || !cur.proposed || io === "off") return { sel: cur };
  const none = { mode: raw, used: false, sha: null, generatedAt: null, proposed: null, picked: null };
  if (io === null) return { sel: cur, ioMap: { ...none, reasons: [`CI_IO_MAP 配置未知：${JSON.stringify(raw)}（按现有规则）`] } };
  const r = f.ioSelect(mode);
  if (!r.sel) return { sel: cur, ioMap: { ...none, reasons: r.reasons } };
  const used = io === "on";
  return { sel: used ? r.sel : cur, ioMap: { mode: raw, used, sha: r.sha, generatedAt: r.generatedAt, ...counts(r.sel, f.slow), reasons: r.sel.fullReasons } };
}

/** The decision plus, for a pull_request with a known PR head, that head: bound into the plan and so into its digest. */
// 回退所需：关闭 CI_QUEUE_LIGHT 后的整次补跑仍须全量，否则排队卡会一直等待全量。
export function buildPlan(f: PlanFacts): CiPlan {
  const force = (f.runAttempt ?? 1) > 1 || f.labels?.includes("ci-full");
  const ordinary = f.event === "pull_request" && !f.headRef.startsWith("train/");
  const mode = ciRelatedChecksMode(f.queueMode || undefined);
  let light: CiPlan["light"], lightError: string | undefined;
  if (ordinary && !force && mode !== "off" && mode !== null && f.lightSelect) {
    try { light = { ...f.lightSelect(), mode: f.queueMode ?? "" }; }
    catch (e) { lightError = `light 图构建失败：${String(e)}`; console.warn(lightError); } // a failed optional proposal keeps observe behavior unchanged
  }
  const plan = ordinary && force ? full(f, ["整次重跑或 ci-full 标签始终全量"])
    : ordinary && mode === "on" ? light ? { version: 1 as const, event: f.event, sha: f.sha, mode: f.mode, scope: "light" as const,
      reasons: light.reasons, tests: light.tests, shards: [light.tests], proposed: light.tests.length, picked: light.tests.length, universe: f.allTests.length }
      : full(f, [lightError ?? "light 图不可用，实际全量"]) : decide(f);
  if (light) plan.light = light;
  if (f.queueMode !== undefined) plan.queueMode = f.queueMode;
  return { ...(f.event === "pull_request" && f.prHead ? { ...plan, prHead: f.prHead } : plan), responsibility: responsibilityOf(f) };
}

/**
 * What this PR is answerable for, whatever the run executes: the selector under on (and the read map when CI_IO_MAP=on) on the
 * same checkout. "all" for main, trains, other events, a dispatch with no PR, and every full fallback of the selector.
 */
export function responsibilityOf(f: PlanFacts): CiResponsibility {
  if (f.event === "push") return responsibility("all", ["push（main）始终全量"]);
  if (f.event === "workflow_dispatch" && !f.dispatchPr) return responsibility("all", ["没有对应 PR 的派发始终全量"]);
  if (f.event !== "pull_request" && f.event !== "workflow_dispatch") return responsibility("all", [`事件 ${f.event} 全量`]);
  if (f.event === "pull_request" && f.headRef.startsWith("train/")) return responsibility("all", ["列车 PR 始终全量"]);
  let sel: ImpactSelection;
  try { sel = ioMapPart(f, "on", f.select("on")).sel; }
  catch (e) { return responsibility("all", [`选择器失败：${(e as Error).message}`]); }
  if (sel.run !== "selected" || !sel.proposed) return responsibility("all", sel.fullReasons.length ? sel.fullReasons : ["选择器没有给出选集"]);
  // decide() 的同一条兜底：去掉慢清单后什么都不剩就全量跑，责任也就是全量（慢测试照旧留在选集里，只是不靠它们撑起非 all）
  if (!withoutSlow(sel.tests, f.slow).length) return responsibility("all", ["排除慢清单后选集为空"]);
  return responsibility(sel.tests);
}

/** The one decision: full unless an ordinary PR under on gets a non-empty bounded selection. */
function decide(f: PlanFacts): CiPlan {
  if (f.event === "push") return full(f, ["push（main）始终全量"]);
  if (f.event === "workflow_dispatch") return full(f, ["串行补验始终全量"]);
  if (f.event !== "pull_request") return full(f, [`事件 ${f.event} 全量`]);
  if (f.headRef.startsWith("train/")) return full(f, ["列车 PR 始终全量"]);
  const mode = f.mode === "" ? undefined : f.mode;
  const { sel, ioMap } = ioMapPart(f, mode, f.select(mode));
  const x: Partial<Extra> = { ...counts(sel, f.slow), ...(ioMap ? { ioMap } : {}) };
  // under on, a map that could not be used is part of why this run is what it is
  const fellBack = ioMap && !ioMap.used && ciIoMapMode(ioMap.mode) === "on" ? ioMap.reasons : [];
  if (sel.run !== "selected") return full(f, [...(sel.fullReasons.length ? sel.fullReasons : [`ciRelatedChecks=${sel.mode}，实际全量`]), ...fellBack], x);
  const tests = withoutSlow(sel.tests, f.slow);
  if (!tests.length) return full(f, ["排除慢清单后选集为空"], { ...x, proposed: 0, picked: 0 });
  return { version: 1, event: f.event, sha: f.sha, mode: f.mode, scope: "related", reasons: [], tests, shards: planShards(tests, SHARDS, f.seconds),
    proposed: tests.length, picked: tests.length, universe: f.allTests.length, ...(ioMap ? { ioMap } : {}) };
}

/** The read map's share of the log line: what PM samples before switching CI_IO_MAP on. */
function ioMapLine(n: IoMapNote | null | undefined, universe: number): string {
  if (!n) return "";
  const head = ` · 读取图 mode=${n.mode || "(缺省 observe)"}${n.used ? " 已采用" : ""}`, why = n.reasons.length ? `（${n.reasons.slice(0, 4).join("；")}）` : "";
  if (n.proposed === null) return `${head} 不可用${why}`;
  return `${head} 读取图会选 ${n.proposed} / ${universe}（图 ${n.sha?.slice(0, 12)}）${n.reasons.length ? `，全量原因${why}，拟选 ${n.picked}` : ""}`;
}

/** One line for the log and the step summary: what PM checks during observe. */
export function planLine(p: CiPlan, digest: string): string {
  const would = p.picked === null ? "无拟选集" : `拟选 ${p.picked} / ${p.universe}`;
  const why = p.reasons.length ? `；全量原因：${p.reasons.slice(0, 8).join("；")}` : "";
  const ran = p.scope !== "full" ? p.tests.length : "全量";
  const light = p.light ? ` · light 会选 ${p.light.tests.length}（改动测试 ${p.light.changed} + 直接引用 ${p.light.direct}）${p.light.reasons.join("；")}` : "";
  return `CI 选择 mode=${p.mode || "(缺省 observe)"} event=${p.event} scope=${p.scope} · ${would} · 实跑 ${ran}${why}${ioMapLine(p.ioMap, p.universe)}${light} · ${digest}`;
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

/** gh / git as the read map's source: the newest successful main push run that is an ancestor of the PR head (HEAD^2). */
function fetchIoMap(root: string, tmp: string, env: Record<string, string | undefined>): IoMapResult {
  const repo = env.GITHUB_REPOSITORY ?? "", dir = join(tmp, "ci-io-map-in");
  const gh = (...args: string[]): string => {
    const r = Bun.spawnSync(["gh", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]}：${r.stderr.toString().trim().slice(0, 200)}`);
    return r.stdout.toString();
  };
  return resolveIoMap({ now: new Date(),
    runs: () => gh("api", `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=50`),
    isAncestor: (sha) => Bun.spawnSync(["git", "merge-base", "--is-ancestor", sha, "HEAD^2"], { cwd: root }).exitCode === 0,
    download: (id) => {
      rmSync(dir, { recursive: true, force: true });
      gh("run", "download", String(id), "-R", repo, "-n", "ci-io-map", "-D", dir);
      return readFileSync(join(dir, "io-map.json"), "utf8");
    } });
}

/**
 * The selectors over the PR's merge commit: changes = first parent → HEAD, base side read from a worktree of the first parent.
 * ioSelect is the same selection with the read map: its entries as edges, and the changes widened by diff(map sha, HEAD).
 */
function prSelect(root: string, tmp: string, headPaths: string[], env: Record<string, string | undefined>): Pick<PlanFacts, "select" | "ioSelect" | "lightSelect"> {
  const git = run(root), scan = oxcScanner(parseSync as unknown as OxcParseSync);
  const diff = (from: string): ReturnType<typeof parseNameStatus> => {
    try { return parseNameStatus(git("diff", "-z", "--name-status", "-M", from, "HEAD")); }
    catch (e) { return { changes: [], bad: [`git diff 失败：${(e as Error).message}`] }; } // read as a full fallback reason by the selector
  };
  let sides: ReturnType<SelectInput["load"]> | undefined, fetched: IoMapResult | undefined;
  const load = () => (sides ??= (() => {
    if (git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length !== 3) throw new Error("PR 检出不是合并提交");
    const baseDir = join(tmp, "ci-related-base");
    if (!existsSync(baseDir)) git("worktree", "add", "--detach", baseDir, "HEAD^1");
    const side = (dir: string, paths: string[]) => {
      const aliases = tsconfigAliases(readFileSync(join(dir, "tsconfig.json"), "utf8"));
      return { paths, graph: buildGraph({ paths, read: (p) => readFileSync(join(dir, p), "utf8") }, scan, aliases) };
    };
    const basePaths = run(baseDir)("ls-files", "-z").split("\0").filter(Boolean);
    return { base: side(baseDir, basePaths), head: side(root, headPaths) };
  })());
  return {
    lightSelect: () => {
      const d = diff("HEAD^1");
      if (d.bad.length) throw new Error(d.bad.join("；"));
      const { base, head } = load();
      const slowFile = join(root, "tests", "slow-tests.txt");
      return selectLightTests(d.changes, base, head, existsSync(slowFile) ? parseSlowList(readFileSync(slowFile, "utf8")) : []);
    },
    select: (mode) => { const d = diff("HEAD^1"); return selectImpactedTests({ mode, changes: d.changes, badChanges: d.bad, headPaths, load }); },
    ioSelect: (mode) => {
      const got = (fetched ??= fetchIoMap(root, tmp, env)); // the plan's own run and the responsibility both ask; one download
      if ("reason" in got) return { sel: null, sha: null, generatedAt: null, reasons: [got.reason] };
      const pr = diff("HEAD^1"), since = diff(got.map.sha);
      const sel = selectImpactedTests({ mode, changes: unionChanges(pr.changes, since.changes), badChanges: [...pr.bad, ...since.bad], headPaths, load,
        ioMap: got.map.entries });
      return { sel, sha: got.map.sha, generatedAt: got.map.generatedAt, reasons: [] };
    },
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
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ");
  const plan = buildPlan({ event, sha: parents[0]!, mode: env.CI_RELATED_CHECKS ?? "", headRef: env.GITHUB_HEAD_REF ?? "",
    ...(event === "pull_request" && parents.length === 3 ? { prHead: parents[2]! } : {}),
    ...(event === "workflow_dispatch" && Number(env.REQ_PR) > 0 && parents.length === 3 ? { dispatchPr: Number(env.REQ_PR) } : {}),
    queueMode: env.CI_QUEUE_LIGHT ?? "", runAttempt: Number(env.GITHUB_RUN_ATTEMPT || "1"), labels: JSON.parse(env.CI_PR_LABELS || "[]"),
    allTests: testFiles(headPaths.join("\n")), slow: existsSync(slowFile) ? parseSlowList(readFileSync(slowFile, "utf8")) : [],
    ...prSelect(root, env.RUNNER_TEMP ?? outDir, headPaths, env), ioMode: env.CI_IO_MAP ?? "", seconds: loadDurations().seconds });
  const digest = planDigest(plan);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 1));
  const line = planLine(plan, digest);
  console.log(line);
  const r = plan.responsibility!;
  console.log(`责任选集 ${r.tests === "all" ? "all" : r.tests.length}${r.fallbackReasons.length ? `（${r.fallbackReasons.slice(0, 4).join("；")}）` : ""} · ${r.digest}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `scope=${plan.scope}\ndigest=${digest}\nmode=${plan.mode || "observe"}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/** related plan → shard k's files; refuses a plan that is not the frozen one (digest) or not related. */
export function shardFiles(text: string, digest: string, k: number): string[] {
  const plan = JSON.parse(text) as CiPlan;
  if (planDigest(plan) !== digest) throw new Error(`plan.json 的 digest ${planDigest(plan)} 不是本次运行冻结的 ${digest}`);
  if (plan.scope !== "related" && plan.scope !== "light") throw new Error("plan 不是 related，分片走全量清单");
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

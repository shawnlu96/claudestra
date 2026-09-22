#!/usr/bin/env bun
// 防腐闸门 CLI（`bun run guard`，`bun run check` 的最后一步）。红了修代码，规则见 CLAUDE.md「防腐规则」。
//   bun scripts/guard/index.ts            检查：超 baseline / 未记录的放宽 / 未记录的闸门改动 / 接线缺失 → exit 1
//   bun scripts/guard/index.ts --update   只收紧 baseline（永不新增、永不提高）
//   选项：--only size,deps（严格模式下不可用）  --json
// 严格模式（GUARD_STRICT=1 或 CI=true）：依赖缺席导致规则被跳过也算失败；本地默认降级跳过。
// 放宽只能手改 baseline.json 并在 raised[] 写 {key,from,to,why}；改 scripts/guard/** 要写 {key:"guard:<path>",…}。
// 没有行内 ignore。--init 只给主会话 / owner 在合并后重建基线用（见 CLAUDE.md），agent 不要用。
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { capFor, DOC_FILES, EXCLUDE, HINTS, PATTERNS, prefixOf, SCAN_DIRS } from "./config.ts";
import { explainChanged, type ChangedFile } from "./explain.ts";
import { checkRaised, compare, initLimits, loosenings, parseBaseline, sortCounts, tighten } from "./ratchet.ts";
import { measureComments } from "./rules/comments.ts";
import { measureDead } from "./rules/dead.ts";
import { measureDeps } from "./rules/deps.ts";
import { measureDup } from "./rules/dup.ts";
import { loadParser, measureFn, type SpanParser } from "./rules/fn.ts";
import { measurePatterns } from "./rules/patterns.ts";
import { measureSize } from "./rules/size.ts";
import { measureTwins } from "./rules/twins.ts";
import { BASELINE_REL, checkSelfRaised, checkWiring, guardSelfFiles, isStrict } from "./self.ts";
import type { Baseline, Counts, Files, Finding, RuleResult } from "./types.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASELINE_PATH = join(ROOT, BASELINE_REL);
const STRICT = isStrict(process.env);

interface Rule {
  id: string;
  prefixes: string[];
  run: (files: Files, docs: Files) => RuleResult | Promise<RuleResult>;
}

const RULES: Rule[] = [
  { id: "size", prefixes: ["size", "longLine", "doc"], run: (f, d) => measureSize(f, d) },
  { id: "fn", prefixes: ["fn", "fnLong"], run: runFn },
  { id: "deps", prefixes: ["deps"], run: (f) => measureDeps(f) },
  { id: "dup", prefixes: ["dup"], run: (f) => measureDup(f) },
  { id: "patterns", prefixes: ["pattern", "catch", "route"], run: (f) => measurePatterns(f) },
  { id: "twins", prefixes: ["twins"], run: (f) => measureTwins(f) },
  { id: "comments", prefixes: ["comments"], run: (f) => measureComments(f) },
  { id: "dead", prefixes: ["dead"], run: () => measureDead(ROOT) },
];

let parserMemo: Promise<{ name: string; parse: SpanParser } | null> | null = null;
const getParser = () => (parserMemo ??= loadParser(ROOT));

async function runFn(files: Files): Promise<RuleResult> {
  const parser = await getParser();
  if (!parser) return { counts: {}, skipped: "没有可用的解析器（oxc-parser 未安装、web/node_modules/typescript 也不在），跳过函数长度检查" };
  const r = measureFn(files, parser.parse);
  return { ...r, detail: [`fn （解析器：${parser.name}）`, ...(r.detail ?? [])] };
}

function git(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

const readText = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);

function loadFiles(): { files: Files; docs: Files } {
  const listed = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCAN_DIRS]).out.split("\n");
  const files: Files = new Map();
  for (const f of new Set(listed)) {
    if (!/\.(ts|tsx|mjs)$/.test(f) || EXCLUDE.some((re) => re.test(f))) continue;
    const text = readText(f);
    if (text !== null) files.set(f, text);
  }
  const docs: Files = new Map();
  for (const f of DOC_FILES) {
    const text = readText(f);
    if (text !== null) docs.set(f, text);
  }
  return { files, docs };
}

/**
 * 比较基准：GUARD_BASE（CI）→ 与 origin/main / upstream 的分叉点 → HEAD。
 * 严格模式下落到 HEAD 本身（force push 后 before 取不到、分支即 main）就退一步用 HEAD~1，至少审计最后一个提交。
 */
function resolveBase(): string {
  const env = process.env.GUARD_BASE?.trim();
  if (env && !/^0+$/.test(env) && git(["rev-parse", "--verify", "--quiet", `${env}^{commit}`]).ok) return env;
  if (env) console.log(`⚠ GUARD_BASE=${env} 取不到（新分支首推 / force push），回退到分叉点`);
  const head = git(["rev-parse", "HEAD"]).out.trim();
  for (const ref of ["origin/main", "@{upstream}"]) {
    const mb = git(["merge-base", "HEAD", ref]).out.trim();
    if (mb && mb !== head) return mb;
  }
  const parent = git(["rev-parse", "--verify", "--quiet", "HEAD~1"]).out.trim();
  if (STRICT && parent) {
    console.log("⚠ 严格模式下比较基准落到了 HEAD 本身，改用 HEAD~1");
    return parent;
  }
  return "HEAD";
}

function loadBaseBaseline(base: string): Baseline | null {
  const r = git(["show", `${base}:${BASELINE_REL}`]);
  return r.ok ? parseBaseline(r.out) : null;
}

/** 相对比较基准改过的文件（含未提交、未跟踪；改名按删 + 增两条算）。 */
function changedFiles(base: string): string[] {
  const diff = git(["diff", "--name-only", "--no-renames", base]).out.split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).out.split("\n");
  return [...new Set([...diff, ...untracked].filter(Boolean))].sort();
}

/** 闸门自身的改动审计；比较基准里还没有闸门（首次采纳）时不适用。 */
function selfAudit(base: string, baseBaseline: Baseline | null, cur: Baseline, changed: string[]): string[] {
  if (!git(["cat-file", "-e", `${base}:scripts/guard/index.ts`]).ok) return [];
  return checkSelfRaised(guardSelfFiles(changed), baseBaseline?.raised ?? [], cur.raised);
}

function hintFor(key: string): string {
  const p = prefixOf(key);
  if (p === "pattern") return PATTERNS.find((x) => `pattern:${x.id}` === key)?.hint ?? "";
  return HINTS[p] ?? "";
}

/** 集合型 key（一条边 / 一个符号 / 一个函数名）：出现即新增违规。 */
const SET_PREFIXES = new Set(["deps", "dead", "twins", "route", "fnLong"]);

function printFinding(f: Finding): void {
  const p = prefixOf(f.key);
  let what = `${f.cur} > ${f.limit}（只许降）`;
  if (SET_PREFIXES.has(p) && f.limit === 0) what = "新增违规";
  else if (p === "size" && f.limit === capFor(f.key)) what = `${f.cur} 行 > 默认上限 ${f.limit}`;
  console.log(`✗ ${f.key} ${what} → ${hintFor(f.key)}`);
}

async function measureAll(only: Set<string> | null) {
  const { files, docs } = loadFiles();
  const counts: Counts = {};
  const skipped = new Set<string>();
  const notes: string[] = [];
  const detail: string[] = [];
  let dupPerFile: Record<string, number> = {};
  for (const rule of RULES) {
    if (only && !only.has(rule.id)) {
      rule.prefixes.forEach((p) => skipped.add(p));
      continue;
    }
    const r = await rule.run(files, docs);
    if (r.skipped) {
      rule.prefixes.forEach((p) => skipped.add(p));
      notes.push(`${rule.id}: ${r.skipped}`);
      continue;
    }
    Object.assign(counts, r.counts);
    detail.push(...(r.detail ?? []));
    if (rule.id === "dup") dupPerFile = r.perFile ?? {};
  }
  return { counts: sortCounts(counts), skipped, notes, detail, files, dupPerFile };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function writeBaseline(b: Baseline): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(b, null, 2)}\n`);
}

const REINIT_REFUSED =
  "✗ baseline 已存在。--init 只给主会话 / owner 在合并后重建基线用（CLAUDE.md「防腐规则」）；guard 红了请修代码。";

async function cmdInit(args: string[], only: Set<string> | null): Promise<number> {
  if (STRICT) {
    console.log("✗ 严格模式（CI）不允许 --init");
    return 1;
  }
  const exists = existsSync(BASELINE_PATH);
  const base = resolveBase();
  const baseBaseline = loadBaseBaseline(base);
  const rebuild = exists || baseBaseline !== null;
  if (rebuild && !(args.includes("--force") && process.env.GUARD_REINIT === "1")) {
    console.log(REINIT_REFUSED);
    return 1;
  }
  const old = exists ? parseBaseline(readFileSync(BASELINE_PATH, "utf8")) : null;
  const m = await measureAll(only);
  const limits = initLimits(m.counts, old?.limits ?? {}, m.skipped);
  const date = new Date().toLocaleDateString("sv-SE");
  const raised = [...(old?.raised ?? [])];
  const up = baseBaseline ? loosenings(baseBaseline.limits, limits) : [];
  if (up.length) {
    const why = (argValue(args, "--why") ?? "").trim();
    if ([...why].length < 10) {
      console.log(`✗ 重建会放宽 ${up.length} 项（相对比较基准）。必须带 --why "<≥10 字的理由>"，会逐项写进 raised[]：`);
      up.slice(0, 20).forEach((r) => console.log(`  ${r.key} ${r.from} → ${r.to}`));
      return 1;
    }
    for (const r of up) raised.push({ ...r, why: `[重建] ${why}`, date });
  }
  const unmeasured = RULES.filter((r) => r.prefixes.every((p) => m.skipped.has(p))).map((r) => r.id);
  const commit = git(["rev-parse", "HEAD"]).out.trim();
  writeBaseline({ version: 1, init: { commit, date, unmeasured }, limits, raised });
  m.notes.forEach((n) => console.log(`– ${n}`));
  const label = rebuild ? "⚠ 重建基线" : "✓ baseline 已按当前实测值建立";
  const note = up.length ? `，放宽 ${up.length} 项（已带「重建」标记记入 raised[]）` : "，没有放宽";
  console.log(`${label}：${Object.keys(limits).length} 项${note}`);
  if (unmeasured.length) console.log(`  未测量的规则：${unmeasured.join(", ")}（依赖装好后由主会话重跑）`);
  return 0;
}

interface Verdict {
  failures: Finding[];
  tightenable: Finding[];
  raisedErrs: string[];
  selfErrs: string[];
  wiringErrs: string[];
  strictErrs: string[];
}

function report(v: Verdict): number {
  v.failures.forEach(printFinding);
  for (const e of v.raisedErrs) {
    console.log(`✗ baseline 放宽没有记录：${e} → 在 raised[] 写 {key, from, to, why(≥10 字)}，commit message 再写一遍`);
  }
  for (const f of v.selfErrs) {
    console.log(`✗ 改了闸门本身却没有记录：${f} → raised[] 新增 {key:"guard:${f}", from:0, to:0, why(≥10 字)}`);
  }
  v.wiringErrs.forEach((e) => console.log(`✗ guard 接线被改：${e}`));
  v.strictErrs.forEach((e) => console.log(`✗ 严格模式不许跳过规则：${e}`));
  if (v.tightenable.length) console.log(`↓ 可收紧 ${v.tightenable.length} 项：跑 bun run guard:update 锁定进步`);
  return v.failures.length + v.raisedErrs.length + v.selfErrs.length + v.wiringErrs.length + v.strictErrs.length;
}

async function explainFailures(v: Verdict, m: Awaited<ReturnType<typeof measureAll>>, base: string, changed: string[]) {
  const failed = new Set(v.failures.map((f) => prefixOf(f.key)));
  if (failed.has("fnLong")) failed.add("fn");
  m.detail.filter((d) => failed.has(d.split(" ")[0])).forEach((d) => console.log(`  · ${d}`));
  const parse = failed.has("fn") ? ((await getParser())?.parse ?? null) : null;
  const touched: ChangedFile[] = changed
    .filter((f) => m.files.has(f))
    .map((f) => {
      const old = git(["show", `${base}:${f}`]);
      return { file: f, cur: m.files.get(f)!, base: old.ok ? old.out : null };
    });
  const lines = explainChanged(touched, failed, parse, m.dupPerFile);
  if (lines.length) console.log("  改过的文件里变多的项：");
  lines.forEach((l) => console.log(`  → ${l}`));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const onlyArg = argValue(args, "--only");
  if (STRICT && onlyArg) {
    console.log("✗ 严格模式（CI）不允许 --only");
    return 1;
  }
  const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
  if (args.includes("--init")) return cmdInit(args, only);
  if (!existsSync(BASELINE_PATH)) {
    console.log(`✗ 没有 ${BASELINE_REL}：由主会话按 CLAUDE.md 的采纳步骤建立`);
    return 1;
  }
  let cur = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
  const t0 = performance.now();
  const m = await measureAll(only);
  const base = resolveBase();
  const baseBaseline = loadBaseBaseline(base);
  const changed = changedFiles(base);
  if (args.includes("--update")) {
    const next = tighten(cur.limits, m.counts, m.skipped);
    const moved = Object.keys(cur.limits).filter((k) => next[k] !== cur.limits[k]);
    moved.forEach((k) => console.log(`↓ ${k}: ${cur.limits[k]} → ${next[k] ?? "删除（已在默认上限内）"}`));
    cur = { ...cur, limits: next };
    writeBaseline(cur);
    console.log(`✓ baseline 收紧 ${moved.length} 项`);
  }
  const cmp = compare(cur.limits, m.counts, m.skipped);
  const v: Verdict = {
    ...cmp,
    raisedErrs: checkRaised(baseBaseline, cur),
    selfErrs: selfAudit(base, baseBaseline, cur, changed),
    wiringErrs: checkWiring(readText("package.json") ?? "", readText(".github/workflows/ci.yml")),
    strictErrs: STRICT ? m.notes : [],
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify({ base, strict: STRICT, ...v, skipped: m.notes, counts: m.counts }, null, 2));
    return report({ ...v, tightenable: [] }) ? 1 : 0;
  }
  if (!STRICT) m.notes.forEach((n) => console.log(`– ${n}`));
  const errors = report(v);
  const ms = (performance.now() - t0).toFixed(0);
  const stat = `${m.files.size} 个文件，${ms}ms，基准 ${base.slice(0, 10)}${STRICT ? "，严格模式" : ""}`;
  if (errors) {
    await explainFailures(v, m, base, changed);
    console.log(`guard ✗ ${errors} 项（${stat}）`);
    console.log("  规则：修代码，不要改 baseline / 闸门；真要放宽见 CLAUDE.md「防腐规则」");
    return 1;
  }
  console.log(`guard ✓（${stat}）`);
  return 0;
}

process.exit(await main());

#!/usr/bin/env bun
// 防腐闸门 CLI。用法：
//   bun scripts/guard/index.ts                 检查（超 baseline 即 exit 1）
//   bun scripts/guard/index.ts --update        只收紧 baseline（永不新增、永不提高）
//   bun scripts/guard/index.ts --init [--force --why "<理由>"]   一次性采纳：按当前实测值建 baseline
//   选项：--only size,deps   --json
// 放宽只能手改 baseline.json 并在 raised[] 写 {key,from,to,why}；没有行内 ignore。
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { EXCLUDE, HINTS, PATTERNS, prefixOf, SCAN_DIRS, DOC_FILES } from "./config.ts";
import { checkRaised, compare, initLimits, loosenings, parseBaseline, sortCounts, tighten } from "./ratchet.ts";
import { measureComments } from "./rules/comments.ts";
import { measureDead } from "./rules/dead.ts";
import { measureDeps } from "./rules/deps.ts";
import { measureDup } from "./rules/dup.ts";
import { loadParser, measureFn } from "./rules/fn.ts";
import { measurePatterns } from "./rules/patterns.ts";
import { measureSize } from "./rules/size.ts";
import { measureTwins } from "./rules/twins.ts";
import type { Baseline, Counts, Files, Finding, RuleResult } from "./types.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASELINE_REL = "scripts/guard/baseline.json";
const BASELINE_PATH = join(ROOT, BASELINE_REL);
const GUARD_SELF = ["scripts/guard/config.ts", "scripts/guard/ratchet.ts", "scripts/guard/rules"];

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

async function runFn(files: Files): Promise<RuleResult> {
  const parser = await loadParser(ROOT);
  if (!parser) return { counts: {}, skipped: "没有可用的解析器（oxc-parser 未安装、web/node_modules/typescript 也不在），跳过函数长度检查" };
  const r = measureFn(files, parser.parse);
  return { ...r, detail: [`（解析器：${parser.name}）`, ...(r.detail ?? [])] };
}

function git(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

function loadFiles(): { files: Files; docs: Files } {
  const listed = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCAN_DIRS]).out.split("\n");
  const files: Files = new Map();
  for (const f of new Set(listed)) {
    if (!/\.(ts|tsx|mjs)$/.test(f) || EXCLUDE.some((re) => re.test(f))) continue;
    const abs = join(ROOT, f);
    if (existsSync(abs)) files.set(f, readFileSync(abs, "utf8"));
  }
  const docs: Files = new Map();
  for (const f of DOC_FILES) if (existsSync(join(ROOT, f))) docs.set(f, readFileSync(join(ROOT, f), "utf8"));
  return { files, docs };
}

/** 比较基准：GUARD_BASE（CI）→ 与 upstream / origin/main 的分叉点 → HEAD。 */
function resolveBase(): string {
  const env = process.env.GUARD_BASE?.trim();
  if (env && !/^0+$/.test(env) && git(["rev-parse", "--verify", "--quiet", `${env}^{commit}`]).ok) return env;
  if (env) console.log(`⚠ GUARD_BASE=${env} 取不到（新分支首推 / force push），回退到分叉点`);
  for (const ref of ["@{upstream}", "origin/main"]) {
    const mb = git(["merge-base", "HEAD", ref]);
    if (mb.ok && mb.out.trim()) return mb.out.trim();
  }
  return "HEAD";
}

function loadBaseBaseline(base: string): Baseline | null {
  const r = git(["show", `${base}:${BASELINE_REL}`]);
  return r.ok ? parseBaseline(r.out) : null;
}

function hintFor(key: string): string {
  const p = prefixOf(key);
  if (p === "pattern") return PATTERNS.find((x) => `pattern:${x.id}` === key)?.hint ?? "";
  return HINTS[p] ?? "";
}

/** 集合型 key（一条边 / 一个符号 / 一个签名）：出现即新增违规。 */
const SET_PREFIXES = new Set(["deps", "dead", "twins", "route", "fnLong"]);

function printFinding(f: Finding): void {
  const what = SET_PREFIXES.has(prefixOf(f.key)) && f.limit === 0 ? "新增违规" : `${f.cur} > ${f.limit}（只许降）`;
  console.log(`✗ ${f.key} ${what} → ${hintFor(f.key)}`);
}

async function measureAll(only: Set<string> | null) {
  const { files, docs } = loadFiles();
  const counts: Counts = {};
  const skipped = new Set<string>();
  const notes: string[] = [];
  const detail: string[] = [];
  for (const rule of RULES) {
    if (only && !only.has(rule.id)) {
      rule.prefixes.forEach((p) => skipped.add(p));
      continue;
    }
    const r = await rule.run(files, docs);
    if (r.skipped) {
      rule.prefixes.forEach((p) => skipped.add(p));
      notes.push(`– ${rule.id}: ${r.skipped}`);
      continue;
    }
    Object.assign(counts, r.counts);
    detail.push(...(r.detail ?? []));
  }
  return { counts: sortCounts(counts), skipped, notes, detail, fileCount: files.size };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function writeBaseline(b: Baseline): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(b, null, 2)}\n`);
}

function headCommit(): string {
  return git(["rev-parse", "HEAD"]).out.trim();
}

async function cmdInit(args: string[], only: Set<string> | null): Promise<number> {
  const exists = existsSync(BASELINE_PATH);
  if (exists && !args.includes("--force")) {
    console.log("✗ baseline.json 已存在。--init 只用于一次性采纳：确实要重建请加 --force --why \"<理由>\"");
    return 1;
  }
  const old = exists ? parseBaseline(readFileSync(BASELINE_PATH, "utf8")) : null;
  const m = await measureAll(only);
  const limits = initLimits(m.counts, old?.limits ?? {}, m.skipped);
  const base = loadBaseBaseline(resolveBase());
  const date = new Date().toLocaleDateString("sv-SE");
  const raised = [...(old?.raised ?? [])];
  const up = base ? loosenings(base.limits, limits) : [];
  if (up.length) {
    const why = (argValue(args, "--why") ?? "").trim();
    if ([...why].length < 10) {
      console.log(`✗ 重建会放宽 ${up.length} 项（相对比较基准）。必须带 --why "<≥10 字的理由>"，会逐项写进 raised[]：`);
      up.slice(0, 20).forEach((r) => console.log(`  ${r.key} ${r.from} → ${r.to}`));
      return 1;
    }
    for (const r of up) raised.push({ ...r, why, date });
  }
  const unmeasured = RULES.filter((r) => r.prefixes.every((p) => m.skipped.has(p))).map((r) => r.id);
  writeBaseline({ version: 1, init: { commit: headCommit(), date, unmeasured }, limits, raised });
  m.notes.forEach((n) => console.log(n));
  console.log(`✓ baseline 已按当前实测值建立：${Object.keys(limits).length} 项，放宽 ${up.length} 项（已记入 raised[]）`);
  if (unmeasured.length) console.log(`  未测量的规则：${unmeasured.join(", ")}（依赖装好后重跑 --init --force）`);
  return 0;
}

function report(v: { failures: Finding[]; tightenable: Finding[] }, raisedErrs: string[]): void {
  v.failures.forEach(printFinding);
  for (const e of raisedErrs) {
    console.log(`✗ baseline 放宽没有记录：${e} → 在 raised[] 写 {key, from, to, why(≥10 字)}，commit message 再写一遍`);
  }
  if (v.tightenable.length) console.log(`↓ 可收紧 ${v.tightenable.length} 项：跑 bun run guard:update 锁定进步`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const onlyArg = argValue(args, "--only");
  const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
  if (args.includes("--init")) return cmdInit(args, only);
  if (!existsSync(BASELINE_PATH)) {
    console.log(`✗ 没有 ${BASELINE_REL}：首次采纳请跑 bun scripts/guard/index.ts --init`);
    return 1;
  }
  const cur = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
  const t0 = performance.now();
  const m = await measureAll(only);
  const v = compare(cur.limits, m.counts, m.skipped);
  const base = resolveBase();
  const baseBaseline = loadBaseBaseline(base);
  const raisedErrs = checkRaised(baseBaseline, cur);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ base, ...v, raisedErrs, skipped: m.notes, counts: m.counts }, null, 2));
    return v.failures.length || raisedErrs.length ? 1 : 0;
  }
  m.notes.forEach((n) => console.log(n));
  if (baseBaseline && !git(["diff", "--quiet", base, "--", ...GUARD_SELF]).ok) {
    console.log("⚠ guard 的规则/配置相对比较基准有改动：commit message 里写清楚为什么改闸门");
  }
  if (args.includes("--update")) {
    const next = tighten(cur.limits, m.counts, m.skipped);
    const changed = Object.keys(cur.limits).filter((k) => next[k] !== cur.limits[k]);
    writeBaseline({ ...cur, limits: next });
    changed.forEach((k) => console.log(`↓ ${k}: ${cur.limits[k]} → ${next[k] ?? "删除（已在默认上限内）"}`));
    console.log(`✓ baseline 收紧 ${changed.length} 项`);
    v.tightenable = [];
  }
  report(v, raisedErrs);
  const ms = (performance.now() - t0).toFixed(0);
  if (v.failures.length || raisedErrs.length) {
    m.detail.forEach((d) => console.log(`  · ${d}`));
    console.log(`guard ✗ ${v.failures.length + raisedErrs.length} 项（${m.fileCount} 个文件，${ms}ms，基准 ${base.slice(0, 10)}）`);
    console.log("  规则：修代码，不要改 baseline；真要放宽见 CLAUDE.md「防腐规则」");
    return 1;
  }
  console.log(`guard ✓（${m.fileCount} 个文件，${ms}ms，基准 ${base.slice(0, 10)}）`);
  return 0;
}

process.exit(await main());

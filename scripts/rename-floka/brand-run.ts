/**
 * BRAND1：用 codemod 一次执行允许的品牌替换。表 = codemod 自带表的 history / protocol 规则 + brand-rules.json（见其 note）。
 * 流程：git archive 出临时检出（不带 node_modules 软链、未跟踪文件）→ plan → apply 到另一个临时目标根 → 拷回工作区
 * （拷回前核工作区文件仍是计划里那一版）→ 在「检出 + 改写」上重扫一次做残留扫描 → 写 brand-result.json。
 * 开关沿用 rename.codemod：off 什么都不做；observe（缺省）只出计划摘要，不写任何文件；on 才改工作区。
 * 用法：bun scripts/rename-floka/brand-run.ts [--mode off|observe|on] [--ref HEAD] [--repo .] [--plan-out <json>] [--result <json>]
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { executePlan } from "./codemod/apply.ts";
import { buildPlan, type CodemodMode, type Plan } from "./codemod/plan.ts";
import type { Rule, RuleSet } from "./codemod/rules.ts";
import bundled from "./codemod/rules.json";
import overlay from "./brand-rules.json";
import { RUNTIME_DIR } from "../../src/lib/paths.ts";

interface Overlay { format: string; version: number; rules: Rule[] }
type Counts = Record<string, { files: number; hits: number }>;

/** 自带表去掉 brand 规则，接上本卡的规则。自带的 history / protocol 排在前面：整份认下文件时先找到的是它们 */
export function brandRuleSet(o: Overlay = overlay as Overlay): RuleSet {
  if (o.format !== "claudestra.rename-brand-overlay" || o.version !== 1) throw new Error("brand-rules.json 不是 v1 overlay");
  const base = bundled as RuleSet;
  return { format: base.format, version: base.version, roots: base.roots, rules: [...base.rules.filter((r) => r.class !== "brand"), ...o.rules] };
}

export const brandRuleIds = (set: RuleSet) => set.rules.filter((r) => r.class === "brand").map((r) => r.id);

function git(repo: string, args: string[]): Buffer {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** ref 的干净检出：git archive 解到临时目录，只有已跟踪文件 */
function checkout(repo: string, ref: string, into: string): string {
  const tar = join(into, "src.tar");
  writeFileSync(tar, git(repo, ["archive", "--format=tar", ref]));
  const root = join(into, "checkout");
  mkdirSync(root);
  const r = Bun.spawnSync(["tar", "-xf", tar, "-C", root], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString().trim()}`);
  rmSync(tar);
  return root;
}

function tally<T extends { file: string; rule: string; count?: number }>(rows: T[]): Counts {
  const out: Counts = {};
  const files = new Map<string, Set<string>>();
  for (const r of rows) {
    const c = (out[r.rule] ??= { files: 0, hits: 0 });
    c.hits += r.count ?? 1;
    const seen = files.get(r.rule) ?? new Set<string>();
    if (!seen.has(r.file)) c.files++;
    files.set(r.rule, seen.add(r.file));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** 计划摘要：按规则数文件和命中，拒绝按类型数 */
function summarize(plan: Plan) {
  const edits = plan.files.flatMap((f) => f.edits.map((e) => ({ file: f.file, rule: e.rule })));
  const rejections: Record<string, number> = {};
  for (const r of plan.rejections) rejections[r.kind] = (rejections[r.kind] ?? 0) + 1;
  return { ok: plan.ok, digest: plan.digest, rulesDigest: plan.rulesDigest, totals: plan.totals, brand: tally(edits), manual: tally(plan.manual), kept: tally(plan.kept), rejections };
}

/** RUNTIME1 的「先改名取走、核对后再放回」崩在中间会留下 .<别名>.floka-unlink-<uuid>：只列，不删 */
export function stagingResidue(dir: string): { scanned: string; found: string[] } {
  const found = existsSync(dir) ? readdirSync(dir).filter((n) => /^\..+\.floka-unlink-[0-9a-f-]{36}$/.test(n)).map((n) => join(dir, n)) : [];
  return { scanned: dir, found: found.sort() };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 拷回前核：工作区里的这个文件必须还是计划里那一版，否则说明工作区和 ref 不一致，整批不拷 */
function copyBack(plan: Plan, written: string[], target: string, repo: string): string[] {
  const want = new Map(plan.files.map((f) => [f.file, f.sha256]));
  const stale = written.filter((rel) => !existsSync(join(repo, rel)) || sha(join(repo, rel)) !== want.get(rel));
  if (stale.length) throw new Error(`工作区和 ref 不一致，不拷回：${stale.slice(0, 5).join("、")}（共 ${stale.length} 个）`);
  for (const rel of written) cpSync(join(target, rel), join(repo, rel));
  return written;
}

/** 残留扫描：检出叠上改写结果再算一次计划。应当没有拒绝、没有可执行的 brand 编辑（重复执行是空操作） */
function residue(checkoutRoot: string, target: string, written: string[], set: RuleSet, work: string) {
  const after = join(work, "after");
  cpSync(checkoutRoot, after, { recursive: true });
  for (const rel of written) cpSync(join(target, rel), join(after, rel));
  const plan = buildPlan(after, set);
  return { ...summarize(plan), unclassified: plan.rejections.filter((r) => r.kind === "unclassified").slice(0, 50) };
}

interface RunOptions { repo: string; ref: string; mode: CodemodMode; planOut?: string; result?: string }

export function runBrand(o: RunOptions) {
  if (o.mode === "off") return { mode: o.mode, skipped: true };
  const set = brandRuleSet();
  const base = git(o.repo, ["rev-parse", o.ref]).toString().trim();
  const work = mkdtempSync(join(tmpdir(), "floka-brand1-"));
  try {
    const root = checkout(o.repo, base, work);
    const plan = buildPlan(root, set, { mode: o.mode });
    if (o.planOut) writeFileSync(o.planOut, `${JSON.stringify(plan, null, 2)}\n`);
    const report = { format: "claudestra.rename-brand-result", version: 1, base, mode: o.mode, plan: summarize(plan), staging: stagingResidue(dirname(RUNTIME_DIR)) };
    if (o.mode !== "on") return report;
    const target = mkdtempSync(join(tmpdir(), "floka-brand1-target-"));
    try {
      const applied = executePlan(root, plan, set, { mode: "on", target, approved: brandRuleIds(set) });
      const written = copyBack(plan, applied.written, target, o.repo);
      const out = { ...report, applied: { edits: applied.edits, written, notApproved: applied.notApproved }, residue: residue(root, target, written, set, work) };
      if (o.result) writeFileSync(o.result, `${JSON.stringify(out, null, 2)}\n`);
      return out;
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): RunOptions {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (!k || !["mode", "ref", "repo", "plan-out", "result"].includes(k) || argv[i + 1] === undefined) throw new Error(`invalid_arguments: ${argv[i]}`);
    a[k] = argv[i + 1]!;
  }
  const mode = (a.mode ?? "observe") as CodemodMode;
  if (!["off", "observe", "on"].includes(mode)) throw new Error("invalid_mode: --mode 只能是 off / observe / on");
  return { repo: resolve(a.repo ?? "."), ref: a.ref ?? "HEAD", mode, planOut: a["plan-out"], result: a.result };
}

if (import.meta.main) {
  try {
    const r = runBrand(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = basename((e as Error).message).startsWith("invalid_") ? 2 : 1;
  }
}

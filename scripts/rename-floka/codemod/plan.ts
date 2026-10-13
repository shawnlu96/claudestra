/**
 * 机械改名的计划（只读）：把扫描根里每一处旧名归到允许表的一条规则上，产出可逐字复现的分类 diff。
 * history → 保留；protocol → 只列进 manual，等人工做兼容；brand → 一条编辑。归不上的、二进制里的、软链指到根外面的、
 * brand 认领到受保护的协议名 / 历史名的，都记进 rejections——有一条就不 ok，apply.ts 不执行。
 * 计划带每个命中文件的 sha256 和整体 digest：执行前重算一遍，对不上就是源变了。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lexFile } from "./lex.ts";
import { compileRules, type CompiledRule, type CompiledRules, type Guard, type Position, type RuleClass, type RuleSet } from "./rules.ts";
import { checkedRoot, EXCLUDED_DIR_NAMES, installCopies, stateDirs, walkTree, within, type FsCtx, type Skipped } from "./scan.ts";

export type CodemodMode = "off" | "observe" | "on";
export interface Edit { rule: string; position: Position; line: number; start: number; end: number; old: string; new: string }
/** 一行改动的前后文本（过长的行截断，只供人看；执行按 edits 的偏移） */
interface Hunk { line: number; before: string; after: string }
interface PlannedFile { file: string; sha256: string; edits: Edit[]; hunks: Hunk[] }
/** 同一文件里同一条规则认下的同一个名字合并成一条：line 是第一处 */
interface Finding { file: string; rule: string; token: string; line: number; count: number }
interface Rejection { kind: string; file: string; line: number; detail: string }
export interface Plan {
  format: "claudestra.rename-codemod-plan";
  version: 1;
  mode: CodemodMode;
  ok: boolean;
  digest: string;
  rulesDigest: string;
  totals: { files: number; hitFiles: number; hits: number; brand: number; protocol: number; history: number; rejected: number };
  rejections: Rejection[];
  /** 每个有命中的文本文件，不管有没有编辑：哈希绑在这里 */
  files: PlannedFile[];
  manual: Finding[];
  kept: Finding[];
  exclusions: { dirNames: Record<string, string>; protectedDirs: string[]; skipped: Skipped[] };
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HUNK_CHARS = 400;
/** 文件名里的旧名：改文件名是 git mv，不是文本替换，一律列为待人工 */
const PATH_RULE = "builtin.path-rename";

interface Range { start: number; end: number }

function ranges(re: RegExp, text: string): Range[] {
  return [...text.matchAll(re)].filter((m) => m[0].length > 0).map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

const covers = (list: Range[], hit: Range) => list.find((r) => r.start <= hit.start && r.end >= hit.end);

function tokenAt(text: string, hit: Range): string {
  const part = /[A-Za-z0-9_.:+@/-]/;
  let a = hit.start;
  let b = hit.end;
  while (a > 0 && part.test(text[a - 1]!)) a--;
  while (b < text.length && part.test(text[b]!)) b++;
  return text.slice(a, b).slice(0, 120);
}

/** 文本内容；读不成文本（含 NUL、不是合法 UTF-8、超过上限）返回 null */
function decode(buf: Buffer): string | null {
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : null;
}

interface Acc {
  files: PlannedFile[];
  findings: Record<"protocol" | "history", Map<string, Finding>>;
  rejections: Rejection[];
  totals: Plan["totals"];
}

function note(acc: Acc, cls: "protocol" | "history", f: Omit<Finding, "count">) {
  const key = `${f.file}\0${f.rule}\0${f.token}`;
  const prev = acc.findings[cls].get(key);
  if (prev) prev.count++;
  else acc.findings[cls].set(key, { ...f, count: 1 });
  acc.totals[cls]++;
}

function reject(acc: Acc, r: Rejection) {
  acc.rejections.push(r);
  acc.totals.rejected++;
}

interface Candidate { c: CompiledRule; length: number; order: number }
type Verdict = { cls: "history" | "protocol"; rule: string } | { cls: "brand"; rule: string; value: string } | null;

/**
 * 一处旧名归谁。history / protocol 只要有一条认领就轮不到 brand（不比长短：协议名被更长的品牌匹配包住也不执行）；
 * 同类里取匹配最长的，等长按表里的先后。brand 还要 replace 里有这个写法的新值，没有就不算认领。
 */
function decide(old: string, cands: Candidate[]): Verdict {
  const best = (cls: RuleClass[], ok: (x: Candidate) => boolean = () => true) =>
    cands.filter((x) => cls.includes(x.c.rule.class) && ok(x)).sort((a, b) => b.length - a.length || a.order - b.order)[0];
  const guard = best(["history", "protocol"]);
  if (guard) return { cls: guard.c.rule.class as "history" | "protocol", rule: guard.c.rule.id };
  const brand = best(["brand"], (x) => Object.hasOwn(x.c.rule.replace ?? {}, old));
  return brand ? { cls: "brand", rule: brand.c.rule.id, value: brand.c.rule.replace![old]! } : null;
}

interface FileScan { file: string; text: string; hits: Range[]; lineOf: (offset: number) => number; startOf: (line: number) => number }

/** 行号从 1 起：lineOf 给偏移所在的行，startOf 给那一行的起始偏移 */
function lineIndex(text: string): Pick<FileScan, "lineOf" | "startOf"> {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { lineOf, startOf: (line) => starts[line - 1]! };
}

/** 没有 match 的 history / protocol 规则按路径认下整份文件：里面每一处、连同文件名里的，都归它 */
function wholeFileRule(file: string, rules: CompiledRules): CompiledRule | undefined {
  return rules.rules.find((c) => c.rule.class !== "brand" && !c.re && c.globs?.some((g) => g.match(file)));
}

function guardRejection(g: Guard, file: string, line: number, token: string, rule: string): Rejection {
  const what = g.class === "protocol" ? "协议形状" : "历史记录";
  return { kind: `brand_over_${g.class}`, file, line, detail: `${token} 是${what}，${rule} 不能按文本替换` };
}

function classifyHits(s: FileScan, rules: CompiledRules, acc: Acc): Edit[] {
  const posAt = lexFile(s.file, s.text);
  const active = rules.rules
    .map((c, order) => ({ c, order }))
    .filter(({ c }) => c.re && (!c.globs || c.globs.some((g) => g.match(s.file))))
    .map((x) => ({ ...x, spans: ranges(x.c.re!, s.text) }));
  // 换表也松不掉的保护：没有 match 的（spans = null）是按路径整份认下的文件，里面每一处都算
  const guards = rules.guards
    .filter((g) => !g.globs || g.globs.some((glob) => glob.match(s.file)))
    .map((g) => ({ g, spans: g.re ? ranges(g.re, s.text) : null }));
  const edits: Edit[] = [];
  for (const hit of s.hits) {
    const position = posAt(hit.start);
    const old = s.text.slice(hit.start, hit.end);
    const line = s.lineOf(hit.start);
    const token = tokenAt(s.text, hit);
    const cands: Candidate[] = [];
    for (const { c, order, spans } of active) {
      // 位置未知（解析失败）时，只有不挑位置的规则还能认领；brand 一定挑位置，所以认不了
      if (c.positions && (!position || !c.positions.has(position))) continue;
      const span = covers(spans, hit);
      if (span) cands.push({ c, order, length: span.end - span.start });
    }
    const v = decide(old, cands);
    let guard: Guard | undefined;
    const where = position ?? "位置未知（文件解析失败）";
    if (!v) reject(acc, { kind: "unclassified", file: s.file, line, detail: `${token}（${where}）没有规则认领` });
    else if (v.cls !== "brand") note(acc, v.cls, { file: s.file, rule: v.rule, token, line });
    else if ((guard = guards.find((x) => !x.spans || covers(x.spans, hit))?.g)) reject(acc, guardRejection(guard, s.file, line, token, v.rule));
    else edits.push({ rule: v.rule, position: position!, line, start: hit.start, end: hit.end, old, new: v.value });
  }
  acc.totals.brand += edits.length;
  return edits;
}

/** 把一份文本按编辑改写（编辑互不重叠，按偏移升序） */
export function rewrite(text: string, edits: Edit[]): string {
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += text.slice(pos, e.start) + e.new;
    pos = e.end;
  }
  return out + text.slice(pos);
}

function hunksOf(text: string, edits: Edit[], lineStart: (line: number) => number): Hunk[] {
  const before = text.split("\n");
  const after = rewrite(text, edits).split("\n"); // 替换值和旧名都不含换行，行数不变
  const first = new Map<number, number>();
  for (const e of edits) if (!first.has(e.line)) first.set(e.line, e.start - lineStart(e.line));
  // 长行只留第一处编辑前后的一段：它之前的文本两边一样，所以同一个起点两边对得齐
  return [...first].map(([line, col]) => {
    const from = before[line - 1]!.length > MAX_HUNK_CHARS ? Math.max(0, col - MAX_HUNK_CHARS / 4) : 0;
    const cut = (s: string) => s.slice(from, from + MAX_HUNK_CHARS);
    return { line, before: cut(before[line - 1]!), after: cut(after[line - 1]!) };
  });
}

function scanPath(file: string, whole: CompiledRule | undefined, rules: CompiledRules, acc: Acc) {
  for (const hit of ranges(rules.root, file)) {
    acc.totals.hits++;
    const token = tokenAt(file, hit);
    if (whole?.rule.class === "history") note(acc, "history", { file, rule: whole.rule.id, token, line: 0 });
    else note(acc, "protocol", { file, rule: whole?.rule.id ?? PATH_RULE, token, line: 0 });
  }
}

function scanFile(root: string, file: string, rules: CompiledRules, acc: Acc) {
  acc.totals.files++;
  const whole = wholeFileRule(file, rules);
  scanPath(file, whole, rules, acc);
  const buf = readFileSync(join(root, file));
  const text = decode(buf);
  if (text === null) {
    // 读不成文本的不改也不猜；里面带旧名字节就拒绝（按 latin1 看字节，旧名都是 ASCII）
    const n = ranges(rules.root, buf.toString("latin1")).length;
    acc.totals.hits += n;
    if (n) reject(acc, { kind: "binary_input", file, line: 0, detail: `二进制或超限文件里有 ${n} 处旧名，不做文本替换` });
    return;
  }
  const hits = ranges(rules.root, text);
  if (!hits.length) return;
  acc.totals.hits += hits.length;
  acc.totals.hitFiles++;
  const scan: FileScan = { file, text, hits, ...lineIndex(text) };
  let edits: Edit[] = [];
  if (whole) {
    const cls = whole.rule.class as "history" | "protocol";
    for (const hit of hits) note(acc, cls, { file, rule: whole.rule.id, token: tokenAt(text, hit), line: scan.lineOf(hit.start) });
  } else {
    edits = classifyHits(scan, rules, acc);
  }
  acc.files.push({ file, sha256: createHash("sha256").update(buf).digest("hex"), edits, hunks: hunksOf(text, edits, scan.startOf) });
}

/** 软链不读也不跟。指到根外面的记拒绝（跟过去就读到了不该读的）；指在根里面的只是别名，真文件自己会被扫到 */
function scanLink(root: string, rel: string, acc: Acc, skipped: Skipped[]) {
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    skipped.push({ path: rel, reason: "悬空软链" }); // 目标不存在：读不到任何内容，记进排除名单即可
    return;
  }
  if (within(real, root)) skipped.push({ path: rel, reason: "根内软链（不跟）" });
  else reject(acc, { kind: "symlink_escape", file: rel, line: 0, detail: "软链指到扫描根外面" });
}

/** 计划的 digest：模式、根的绝对路径、排除名单不进——同一份源、同一张表，在哪台机器上算都一样 */
export function planDigest(p: Pick<Plan, "rulesDigest" | "files" | "manual" | "kept" | "rejections">): string {
  return createHash("sha256").update(JSON.stringify([p.rulesDigest, p.files, p.manual, p.kept, p.rejections])).digest("hex");
}

interface PlanOptions extends Partial<FsCtx> { mode?: CodemodMode }

/** 生成计划。只读：不写任何文件，不跟软链，不进依赖、构建物、状态目录和外部安装副本 */
export function buildPlan(root: string, set: RuleSet, opts: PlanOptions = {}): Plan {
  const ctx: FsCtx = { env: opts.env ?? process.env, home: opts.home ?? homedir() };
  const rules = compileRules(set);
  const real = checkedRoot(root, ctx);
  const guarded = [...stateDirs(ctx), ...installCopies(ctx.home)];
  // 根本身落在状态目录里的检出（已过 checkedRoot）不能再按「在状态目录里」跳过它自己的子目录
  const blocked = guarded.filter((d) => !within(real, d));
  const skipped: Skipped[] = [];
  const acc: Acc = {
    files: [],
    findings: { protocol: new Map(), history: new Map() },
    rejections: [],
    totals: { files: 0, hitFiles: 0, hits: 0, brand: 0, protocol: 0, history: 0, rejected: 0 },
  };
  for (const entry of walkTree(real, blocked, skipped)) {
    if (entry.link) scanLink(real, entry.rel, acc, skipped);
    else scanFile(real, entry.rel, rules, acc);
  }
  const body = { rulesDigest: rules.digest, files: acc.files, manual: [...acc.findings.protocol.values()], kept: [...acc.findings.history.values()], rejections: acc.rejections };
  return {
    format: "claudestra.rename-codemod-plan",
    version: 1,
    mode: opts.mode ?? "observe",
    ok: acc.rejections.length === 0,
    digest: planDigest(body),
    ...body,
    totals: acc.totals,
    exclusions: { dirNames: EXCLUDED_DIR_NAMES, protectedDirs: guarded, skipped },
  };
}

/** 给人看的分类 diff：brand 是逐行的 - / +，protocol 和 history 只列名字，拒绝项单列。同一份计划渲染结果逐字相同 */
export function renderDiff(plan: Plan): string {
  const t = plan.totals;
  const out = [
    `# rename.codemod ${plan.mode} · digest ${plan.digest}`,
    `# 文件 ${t.files} · 旧名 ${t.hits} 处：brand ${t.brand} / protocol ${t.protocol} / history ${t.history} / 拒绝 ${t.rejected}`,
    "",
    "## brand（可执行）",
  ];
  for (const f of plan.files.filter((x) => x.edits.length)) {
    out.push(`--- a/${f.file}`, `+++ b/${f.file}`);
    for (const h of f.hunks) {
      const ids = [...new Set(f.edits.filter((e) => e.line === h.line).map((e) => `${e.rule}/${e.position}`))].join(", ");
      out.push(`@@ ${h.line} @@ ${ids}`, `-${h.before}`, `+${h.after}`);
    }
  }
  const list = (title: string, rows: Finding[]) => {
    out.push("", title);
    for (const r of rows) out.push(`${r.file}:${r.line}  ${r.token}  [${r.rule}]${r.count > 1 ? ` ×${r.count}` : ""}`);
  };
  list("## protocol（待人工兼容，不替换）", plan.manual);
  list("## history（保留）", plan.kept);
  out.push("", "## 拒绝");
  for (const r of plan.rejections) out.push(`${r.kind}  ${r.file}:${r.line}  ${r.detail}`);
  return `${out.join("\n")}\n`;
}

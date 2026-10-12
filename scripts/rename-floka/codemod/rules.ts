/**
 * 机械改名的允许表（rules.json）：读入、校验、编译。三类规则——history（保留）、protocol（只报待人工兼容项）、
 * brand（唯一可执行的一类）。brand 规则必须把文件、词法位置、匹配和替换值四样都写明，缺一样整张表作废。
 * PROTOCOL_SHAPES 写在代码里而不是表里：换一张规则表也松不掉它（见 plan.ts 的 brand_over_protocol）。
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stateDirIn } from "../../../src/lib/state-dir.ts";

export type RuleClass = "history" | "protocol" | "brand";
/** 词法位置。JS / TS 由解析器给出 comment / string / jsx-text / code；文档类扩展名是 text；其余文件不分，一律 data */
export type Position = "comment" | "string" | "jsx-text" | "code" | "text" | "data";

export interface Rule {
  id: string;
  class: RuleClass;
  /** 路径 glob（相对扫描根，正斜杠）。brand 必填；别的类不写就是全部文件 */
  files?: string[];
  positions?: Position[];
  /** 正则源码：一处旧名被它的某次匹配整个包住才归这条规则。history / protocol 不写 = files 里的整份文件 */
  match?: string;
  /** 旧名的写法 → 新值，逐个写明。表里没有的写法这条规则不认领 */
  replace?: Record<string, string>;
  reason: string;
}
export interface RuleSet { format: string; version: number; roots: string[]; rules: Rule[] }

export interface CompiledRule { rule: Rule; re: RegExp | null; globs: Bun.Glob[] | null; positions: Set<Position> | null }
export interface CompiledRules { root: RegExp; rules: CompiledRule[]; shapes: RegExp[]; digest: string }

const RULES_FORMAT = "claudestra.rename-codemod-rules";
const CLASSES: RuleClass[] = ["history", "protocol", "brand"];
const POSITIONS: Position[] = ["comment", "string", "jsx-text", "code", "text", "data"];

/**
 * 持久化 / 跨进程 / 跨版本的名字长什么样：环境变量、签名用途与线上标签、HTTP 头、MCP 工具前缀、反向域名 label、
 * 状态目录、cookie / 存储键、网络地址、agent 与 peer 身份。落在这些形状里的旧名改了要迁移或双认，文本替换做不了，
 * 所以 brand 规则认领到它们时不执行，整个计划记一条拒绝。
 */
const PROTOCOL_SHAPES: string[] = [
  "CLAUDESTRA_[A-Z0-9_]*",
  "(?:claudestra|cstra)-[a-z0-9-]+-v\\d+(?![\\w-])|claudestra-relay\\.v\\d+",
  "(?<![/\\w])[Xx]-(?:[Cc]laudestra|cstra)-[A-Za-z-]+",
  "mcp__claudestra\\w*",
  "(?:com|ai|io)\\.claudestra[\\w.-]*",
  `${basename(stateDirIn("/")).replace(/[.]/g, "\\.")}[\\w./-]*`, // 状态目录名取自定义处，不在这里另写一份字面量
  "cstra_[A-Za-z0-9_]+",
  "[A-Za-z][A-Za-z0-9+.-]*:\\\\?/\\\\?/[^\\s\"'`<>]+",
  "agent-[Cc]laudestra[\\w-]*|peer:[Cc]laudestra[\\w.]*|[\\w.-]+@[Cc]laudestra\\w*|[Cc]laudestra@[\\w-]+",
];

/** 什么路径都匹配的 glob 不算「明确的文件」：拿两个不可能真实存在的探针路径试，都中就是通配 */
const isUniversal = (glob: string) => ["zzq", "zzq/zzq.zzq"].every((probe) => new Bun.Glob(glob).match(probe));

function tryRegex(source: string, what: string, problems: string[]): RegExp | null {
  try {
    return new RegExp(source, "g");
  } catch (e) {
    problems.push(`${what}: 正则不合法（${(e as Error).message}）`);
    return null;
  }
}

function checkBrand(r: Rule, root: RegExp | null, problems: string[]) {
  if (!r.files?.length) problems.push(`${r.id}: brand 规则必须写 files`);
  for (const g of r.files ?? []) if (isUniversal(g)) problems.push(`${r.id}: files 里的 ${g} 是通配，不算明确的文件`);
  if (!r.positions?.length) problems.push(`${r.id}: brand 规则必须写 positions`);
  if (!r.match) problems.push(`${r.id}: brand 规则必须写 match`);
  const pairs = Object.entries(r.replace ?? {});
  if (!pairs.length) problems.push(`${r.id}: brand 规则必须写 replace`);
  for (const [from, to] of pairs) {
    if (typeof to !== "string" || !to) problems.push(`${r.id}: ${from} 的替换值为空`);
    else if (root && new RegExp(root.source).test(to)) problems.push(`${r.id}: 替换值 ${to} 里还有旧名，重复执行会接着改`);
    if (root && !new RegExp(`^(?:${root.source})$`).test(from)) problems.push(`${r.id}: replace 的键 ${from} 不是 roots 能整个匹配的旧名`);
  }
}

function checkRule(r: Rule, root: RegExp | null, seen: Set<string>, problems: string[]) {
  if (!r.id || seen.has(r.id)) problems.push(`规则 id 缺失或重复：${r.id}`);
  seen.add(r.id);
  if (!CLASSES.includes(r.class)) problems.push(`${r.id}: class 不是 history / protocol / brand`);
  if (!r.reason?.trim()) problems.push(`${r.id}: 缺 reason`);
  for (const p of r.positions ?? []) if (!POSITIONS.includes(p)) problems.push(`${r.id}: 不认识的词法位置 ${p}`);
  if (r.class === "brand") checkBrand(r, root, problems);
  else {
    if (r.replace) problems.push(`${r.id}: 只有 brand 规则能带 replace`);
    if (!r.match && !r.files?.length) problems.push(`${r.id}: match 和 files 至少写一个`);
  }
}

/** 校验并编译。有任何问题就整张表作废（抛 rules_invalid），不带着半张表往下跑 */
export function compileRules(set: RuleSet): CompiledRules {
  const problems: string[] = [];
  if (set?.format !== RULES_FORMAT || set.version !== 1) problems.push(`format/version 不是 ${RULES_FORMAT} v1`);
  const roots = Array.isArray(set?.roots) ? set.roots : [];
  const list = Array.isArray(set?.rules) ? set.rules : [];
  if (!roots.length) problems.push("roots 为空");
  const root = roots.length ? tryRegex(roots.join("|"), "roots", problems) : null;
  const seen = new Set<string>();
  const rules = list.map((r): CompiledRule => {
    checkRule(r, root, seen, problems);
    return {
      rule: r,
      re: r.match ? tryRegex(r.match, r.id, problems) : null,
      globs: r.files?.length ? r.files.map((g) => new Bun.Glob(g)) : null,
      positions: r.positions?.length ? new Set(r.positions) : null,
    };
  });
  if (problems.length || !root) throw new Error(`rules_invalid: ${problems.join("；")}`);
  const digest = createHash("sha256").update(JSON.stringify([roots, list, PROTOCOL_SHAPES])).digest("hex");
  return { root, rules, shapes: PROTOCOL_SHAPES.map((s) => new RegExp(s, "g")), digest };
}

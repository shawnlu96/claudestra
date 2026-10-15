/**
 * rename.installConfig 的逐项计划（只读）：外部 Claude settings、仓库 .env、已装 skills 软链、master 模板。
 * 本迁移只拥有两类条目：settings 的新族 allow 规则、.env 里登记变量的 FLOKA_ 同值副本；其余全是 keep / skip，
 * 用户自定义与其他插件的条目只报告、不写。tests/floka-install-config.test.ts。
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { LEGACY_FAMILY, MCP_FAMILIES, NEW_FAMILY, mcpToolPrefix, type McpFamily } from "../floka-mcp/families.js";
import { ENV_FAMILIES, LEGACY_PREFIX } from "../floka-env/names.js";
import { object, renameMode, type RenameMode } from "../floka-config/values.js";
import { readClaudeSettings, type ClaudeSettings } from "../session-recall.js";
import { listRepoSkills } from "../skills-install.js";

export const installConfigMode = (config: unknown): RenameMode => renameMode(object(object(config).rename).installConfig);

export interface InstallHome { home: string; repoRoot: string }
export const settingsPathOf = (h: InstallHome): string => join(h.home, ".claude", "settings.json");
export const envPathOf = (h: InstallHome): string => join(h.repoRoot, ".env");

const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
const print = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** 写入器实际落到的文件：跟随软链（含悬空软链）到底；文件还不存在就是真实父目录下的同名文件 */
function resolvedFile(path: string): string {
  let p = resolve(path);
  for (let hop = 0; hop < 40; hop++) {
    try { return realpathSync(p); } catch { /* 不存在或悬空：下面逐跳解析 */ }
    try { p = resolve(dirname(p), readlinkSync(p)); } catch { return join(canonical(dirname(p)), basename(p)); }
  }
  return p;
}
/** 单个受管文件的身份：解析软链后的真实路径指纹。软链改指向别处、换仓库 / HOME 都是另一个目标 */
export const fileTarget = (path: string): string => print(resolvedFile(path));
/** 本次迁移整体的目标身份（生产入口的 txId 用）：HOME、仓库目录与两个受管文件的解析后目标 */
export const installTarget = (h: InstallHome): string =>
  print([canonical(h.home), canonical(h.repoRoot), resolvedFile(settingsPathOf(h)), resolvedFile(envPathOf(h))].join("\0"));

/** 本迁移拥有的 allow：两族各一条通配，旧的那条永远保留（旧族会话还在用） */
export const familyAllow = (f: McpFamily): string => `${mcpToolPrefix(f)}*`;
export const familyToolName = (f: McpFamily, tool: string): string => `${mcpToolPrefix(f)}${tool}`;

/** .env 里补同值新名的族：路径 / 运行时 / profile。凭据（部署锁 token）、隔离与按会话注入的变量不进 .env 副本 */
const TWIN_SUFFIXES: readonly string[] = [...ENV_FAMILIES["state-runtime"], ...ENV_FAMILIES["acp-pi-codex"],
  ...ENV_FAMILIES.caller, ...ENV_FAMILIES.profile];

type PlanAction = "add" | "keep" | "skip" | "conflict";
export interface PlanEntry { item: "settings.allow" | "settings.hooks" | "env" | "skills" | "template" | "consumer"; key: string; action: PlanAction; note: string }

/** 机械改名不搬的东西：换名后仍按旧名读，列出来给后续卡逐个接 */
const COMPAT_CONSUMERS: readonly PlanEntry[] = [
  { item: "consumer", key: "transcripts", action: "keep",
    note: "历史 transcript 里的 mcp__claudestra__* 调用原样保留；读历史的 watcher 两族前缀都认（floka-mcp/recognize.ts）" },
  { item: "consumer", key: "project-graph", action: "keep", note: "project-nexus 图的项目名仍是 claudestra（.claude/agents/claudestra.md）" },
  { item: "consumer", key: "memory-namespace", action: "keep", note: "auto-memory 目录按工作目录 slug 命名、mem0 按 cwd 召回，不随品牌改" },
  { item: "consumer", key: "master-render", action: "keep", note: "setup.ts 渲染 master/CLAUDE.md 时模板已同时写明两族全名，旧会话照旧、新会话按新名调" },
];

const ANY_KEY = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/;
const ENV_LINE = /^(\s*(?:export\s+)?)(CLAUDESTRA|FLOKA)_([A-Z0-9_]+)\s*=(.*)$/;
export const valuePrint = (rhs: string): string => createHash("sha256").update(rhs.trim()).digest("hex").slice(0, 16);

/**
 * 一条赋值占几行物理行：与 env-file.ts parseDotenv（Bun 口径）同一规则——引号值的闭合引号是其后只剩空白 / 注释的那个
 * 同类引号，可以落在后面的行上；找不到闭合就按未加引号的单行处理。lines 已去掉行尾 CR（CRLF 文件同一口径）。
 */
function assignmentSpan(lines: string[], i: number, rhs: string): number {
  const v = rhs.replace(/^[ \t]+/, ""), q = v[0];
  if (q !== '"' && q !== "'" && q !== "`") return 1;
  const rest = [v.slice(1), ...lines.slice(i + 1)].join("\n");
  const close = new RegExp(`${q}[ \\t]*(?:#[^\\n]*)?(?:\\n|$)`).exec(rest);
  return close ? rest.slice(0, close.index).split("\n").length : 1;
}

/**
 * index 是赋值首行，span 是它占的物理行数；rhs 是 `=` 后的完整原文字节（多行值含换行与中间行的 CR），不含末行的行尾 CR，
 * eol 是末行的行尾 CR（CRLF 文件为 "\r"）。多行值内部的行不当赋值认。
 */
export interface EnvLine { index: number; span: number; brand: "CLAUDESTRA" | "FLOKA"; suffix: string; rhs: string; lead: string; eol: string }
export function envLines(text: string): EnvLine[] {
  const out: EnvLine[] = [], raw = text.split("\n"), lines = raw.map(l => l.replace(/\r$/, ""));
  for (let index = 0; index < lines.length; index++) {
    const any = ANY_KEY.exec(lines[index]!);
    if (!any) continue;
    const span = assignmentSpan(lines, index, any[1]!), m = ENV_LINE.exec(lines[index]!);
    if (m && TWIN_SUFFIXES.includes(m[3]!)) {
      const cr = (i: number) => raw[i]!.length - lines[i]!.length ? "\r" : "", last = index + span - 1;
      const rhs = span === 1 ? m[4]! : [m[4]! + cr(index), ...raw.slice(index + 1, last), lines[last]!].join("\n");
      out.push({ index, span, lead: m[1]!, brand: m[2] as EnvLine["brand"], suffix: m[3]!, rhs, eol: cr(last) });
    }
    index += span - 1;
  }
  return out;
}

/** 每个登记的旧名：没有新名 → add；新名同值 → keep；新名不同值 → skip（用户自己的，不碰） */
export function planEnvText(text: string): PlanEntry[] {
  const lines = envLines(text);
  return lines.filter(l => l.brand === "CLAUDESTRA").map(l => {
    const twin = lines.find(t => t.brand === "FLOKA" && t.suffix === l.suffix);
    const action: PlanAction = !twin ? "add" : twin.rhs.trim() === l.rhs.trim() ? "keep" : "skip";
    return { item: "env" as const, key: `FLOKA_${l.suffix}`, action,
      note: action === "skip" ? "已有不同值的新名，按用户自定义保留" : `与 ${LEGACY_PREFIX}${l.suffix} 同值` };
  });
}

export const readText = (path: string): string | null => existsSync(path) ? readFileSync(path, "utf8") : null;
export const allowList = (s: ClaudeSettings): unknown[] => Array.isArray(object(s.permissions).allow) ? object(s.permissions).allow : [];

function planSettings(h: InstallHome, s: ClaudeSettings): PlanEntry[] {
  const allow = allowList(s);
  const out: PlanEntry[] = MCP_FAMILIES.map(f => ({ item: "settings.allow" as const, key: familyAllow(f),
    action: allow.includes(familyAllow(f)) ? "keep" as const : f === NEW_FAMILY ? "add" as const : "skip" as const,
    note: f === LEGACY_FAMILY ? "旧族规则只保留不新增（install-cli 照旧维护）" : "新族会话的工具通配" }));
  if (object(s.permissions).allow !== undefined && !Array.isArray(object(s.permissions).allow)) {
    out.push({ item: "settings.allow", key: "permissions.allow", action: "conflict", note: "不是数组，拒绝改写" });
  }
  const hooksDir = `${resolve(h.repoRoot)}/src/hooks/`;
  for (const [event, entries] of Object.entries(object(s.hooks))) {
    for (const e of Array.isArray(entries) ? entries : []) for (const hook of Array.isArray(e?.hooks) ? e.hooks : []) {
      if (typeof hook?.command === "string" && hook.command.includes(hooksDir)) out.push({ item: "settings.hooks", key: `${event}:${hook.command.slice(hook.command.lastIndexOf("/") + 1)}`,
        action: "keep", note: "两族共用同一条 hook，按会话族取工具名（hooks/hook-family.ts）" });
    }
  }
  return out;
}

function planSkill(h: InstallHome, name: string): PlanEntry {
  const dst = join(h.home, ".claude", "skills", name), src = resolve(h.repoRoot, "skills", name);
  const text = readText(join(src, "SKILL.md")) ?? "";
  if (text.includes(mcpToolPrefix(LEGACY_FAMILY))) return { item: "skills", key: name, action: "conflict", note: "SKILL.md 写死旧族工具名，新族会话调不到" };
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(dst); } catch { st = null; } // 不存在就是没装：install-cli 负责装，本迁移不建
  if (!st) return { item: "skills", key: name, action: "skip", note: "未安装（install-cli 管安装）" };
  let own = false;
  try { own = st.isSymbolicLink() && realpathSync(dst) === realpathSync(src); } catch { own = false; } // 悬空软链不是本仓的有效安装
  return own ? { item: "skills", key: name, action: "keep", note: "本仓软链；技能名不带品牌，两族共用" }
    : { item: "skills", key: name, action: "skip", note: "用户目录或指向别处，不碰" };
}

/** 模板里每个旧族工具全名，都要同时写明新族全名，否则新族会话照着模板调不到 */
export function planTemplate(text: string): PlanEntry[] {
  const tools = [...new Set([...text.matchAll(/mcp__claudestra__([a-z_]+)/g)].map(m => m[1]!))];
  return tools.map(t => ({ item: "template" as const, key: t,
    action: text.includes(familyToolName(NEW_FAMILY, t)) ? "keep" as const : "conflict" as const,
    note: `旧族 ${familyToolName(LEGACY_FAMILY, t)} / 新族 ${familyToolName(NEW_FAMILY, t)}` }));
}

export async function planInstallConfig(h: InstallHome): Promise<PlanEntry[]> {
  const settings = await readClaudeSettings(settingsPathOf(h));
  return [
    ...planSettings(h, settings),
    ...planEnvText(readText(envPathOf(h)) ?? ""),
    ...listRepoSkills(h.repoRoot).map(n => planSkill(h, n)),
    ...planTemplate(readText(join(h.repoRoot, "master", "CLAUDE.md.template")) ?? ""),
    ...COMPAT_CONSUMERS,
  ];
}

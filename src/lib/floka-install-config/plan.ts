/**
 * rename.installConfig 的逐项计划（只读）：外部 Claude settings、仓库 .env、已装 skills 软链、master 模板。
 * 本迁移只拥有两类条目：settings 的新族 allow 规则、.env 里登记变量的 FLOKA_ 同值副本；其余全是 keep / skip，
 * 用户自定义与其他插件的条目只报告、不写。tests/floka-install-config.test.ts。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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

const ENV_LINE = /^(\s*(?:export\s+)?)(CLAUDESTRA|FLOKA)_([A-Z0-9_]+)\s*=(.*)$/;
export const valuePrint = (rhs: string): string => createHash("sha256").update(rhs.trim()).digest("hex").slice(0, 16);

export interface EnvLine { index: number; brand: "CLAUDESTRA" | "FLOKA"; suffix: string; rhs: string; lead: string }
export function envLines(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  text.split("\n").forEach((line, index) => {
    const m = ENV_LINE.exec(line);
    if (m && TWIN_SUFFIXES.includes(m[3]!)) out.push({ index, lead: m[1]!, brand: m[2] as EnvLine["brand"], suffix: m[3]!, rhs: m[4]! });
  });
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

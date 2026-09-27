/**
 * Skill / slash-command 发现
 *
 * 来源：
 *   1. 用户全局：~/.claude/skills/<name>/SKILL.md
 *   2. 插件：~/.claude/plugins/cache/<market>/<plugin>/<version>/skills/<name>/SKILL.md
 *      (调用名为 `<plugin>:<name>`，例如 `discord:access`)
 *   3. 项目级：<agent cwd>/.claude/skills/<name>/SKILL.md
 *   4. Claude Code 原生 bundled skills：硬编码（binary 里打包，无法扫）
 *   5. Claude Code 原生 built-in commands：手工挑选（`/context`、`/cost`、`/mcp` 等）
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

export type SkillScope = "user" | "plugin" | "project" | "native" | "builtin";

export interface SkillDef {
  /** Claude Code 里真正的调用名（带 `:` 前缀如果是插件） */
  invokeName: string;
  /** Discord 里注册的 slash command 名（`:` 替换为 `-`） */
  discordName: string;
  description: string;
  scope: SkillScope;
  /** 插件 skill 才有 */
  pluginName?: string;
  /** 项目 skill 才有，记录哪个 agent（window 名） */
  agentName?: string;
}

const HOME = process.env.HOME || "";
const USER_SKILLS_DIR = `${HOME}/.claude/skills`;
const PLUGINS_CACHE_DIR = `${HOME}/.claude/plugins/cache`;
const PLUGINS_INDEX = `${HOME}/.claude/plugins/installed_plugins.json`;

/** Discord 命令名限制：小写 + 字母 + 数字 + `-` + `_`，长度 1-32 */
const DISCORD_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function toDiscordName(invoke: string): string {
  // `:` → `-`，其它非法字符去掉
  return invoke.toLowerCase().replace(/:/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

/** 解析 SKILL.md 的 frontmatter */
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const body = content.slice(3, end);
  const result: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2"); // YAML 引号包起来的值（name: "openai-docs"）
  }
  return result;
}

export interface SkillMeta {
  name: string;
  description: string;
  /** frontmatter `user-invocable`，缺省 true（官方文档）：false 才从 / 菜单里藏起来 */
  userInvocable: boolean;
  /** frontmatter `disable-model-invocation: true` ⇒ false：模型不会自己加载，只能手动 /name */
  modelInvocable: boolean;
}

const FALSEY_RE = /^(false|no|0)$/i;
const TRUTHY_RE = /^(true|yes|1)$/i;

/**
 * 读一个技能目录的 SKILL.md。缺省值照 Claude Code 官方文档：name 缺省用目录名，description 缺省用正文第一行非空文字，
 * user-invocable 缺省 true。以前 name 缺了整个技能就不认、user-invocable 没写就当 false——没写这两个键的技能
 * （比如 home-media-pipeline）在 Discord / 网页的命令面板里都消失了。
 */
export async function readSkillMd(path: string, dirName: string): Promise<SkillMeta | null> {
  try {
    const content = await Bun.file(path).text();
    const fm = parseFrontmatter(content);
    const body = content.startsWith("---") ? content.slice(content.indexOf("\n---", 3) + 4) : content;
    const firstLine = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
    return {
      name: (fm.name || dirName).trim(),
      description: (fm.description || firstLine).trim(),
      userInvocable: !FALSEY_RE.test(fm["user-invocable"] || ""),
      modelInvocable: !TRUTHY_RE.test(fm["disable-model-invocation"] || ""),
    };
  } catch (e) {
    console.warn(`读 SKILL.md 失败（跳过这个技能）: ${path}: ${(e as Error).message}`);
    return null;
  }
}

async function scanSkillDir(dir: string): Promise<SkillMeta[]> {
  if (!existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const skillPath = join(dir, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const parsed = await readSkillMd(skillPath, entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function discoverUserSkills(): Promise<SkillDef[]> {
  const items = await scanSkillDir(USER_SKILLS_DIR);
  return items
    .filter((s) => s.userInvocable)
    .map((s) => ({
      invokeName: s.name,
      discordName: toDiscordName(s.name),
      description: s.description,
      scope: "user" as const,
    }))
    .filter((s) => DISCORD_NAME_RE.test(s.discordName));
}

export async function discoverPluginSkills(): Promise<SkillDef[]> {
  if (!existsSync(PLUGINS_INDEX)) return [];
  let index: any;
  try {
    index = await Bun.file(PLUGINS_INDEX).json();
  } catch {
    return [];
  }
  const plugins = index?.plugins || {};
  const out: SkillDef[] = [];
  for (const [pluginKey, instances] of Object.entries(plugins)) {
    const pluginName = pluginKey.split("@")[0]; // "discord@claude-plugins-official" → "discord"
    const installList = Array.isArray(instances) ? instances : [];
    for (const inst of installList) {
      const installPath = inst?.installPath;
      if (!installPath) continue;
      const skillsDir = `${installPath}/skills`;
      const items = await scanSkillDir(skillsDir);
      for (const s of items) {
        if (!s.userInvocable) continue;
        const invoke = `${pluginName}:${s.name}`;
        const discord = toDiscordName(invoke);
        if (!DISCORD_NAME_RE.test(discord)) continue;
        out.push({
          invokeName: invoke,
          discordName: discord,
          description: s.description,
          scope: "plugin",
          pluginName,
        });
      }
    }
  }
  return out;
}

export async function discoverProjectSkills(agentName: string, cwd: string): Promise<SkillDef[]> {
  const items = await scanSkillDir(`${cwd}/.claude/skills`);
  return items
    .filter((s) => s.userInvocable)
    .map((s) => ({
      invokeName: s.name,
      discordName: toDiscordName(s.name),
      description: s.description,
      scope: "project" as const,
      agentName,
    }))
    .filter((s) => DISCORD_NAME_RE.test(s.discordName));
}

/** Claude Code 打包进 binary 的 skill —— 来自 docs.claude.com */
export const NATIVE_SKILLS: SkillDef[] = [
  { invokeName: "batch", discordName: "batch", description: "在 5-30 个 git worktree 里并行跑大规模改动", scope: "native" },
  { invokeName: "claude-api", discordName: "claude-api", description: "加载 Claude API / Anthropic SDK 参考资料", scope: "native" },
  { invokeName: "debug", discordName: "debug", description: "开 debug 日志并排查问题", scope: "native" },
  { invokeName: "fewer-permission-prompts", discordName: "fewer-permission-prompts", description: "扫日志自动生成 permission allowlist", scope: "native" },
  { invokeName: "loop", discordName: "loop", description: "按 interval 反复跑一个 prompt", scope: "native" },
  { invokeName: "simplify", discordName: "simplify", description: "review 代码质量 + 并行多 agent 修复", scope: "native" },
  { invokeName: "team-onboarding", discordName: "team-onboarding", description: "根据使用历史生成团队 onboarding 指南", scope: "native" },
];

/**
 * 每个 Claude Code agent 一份设置文件 `<state>/agent-settings/<registry 名>.json`，启动时 `--settings <文件>` 带进去
 * （lib/claude-launch.ts）。现在只放 skillOverrides（按 agent 启停技能），读写按 key 合并，以后按 agent 切源等键放进来互不干扰。
 * 写者只有 manager（skill-toggle）；bridge 只读。不碰全局 ~/.claude/settings.json：CC Switch 切供应商会整份重写它。
 *
 * 实测（CC 2.1.283，docs 02-03 附录 C2）：
 * - 文件不存在时 `--settings` 直接报错退出 → 只有文件在、且能解析时才带 flag；
 * - 会话运行中改文件不生效（/reload-skills 也不行），重启（含 --resume）后生效 → 界面只提示「重启后生效」；
 * - 显式写 "on" 会让 /skills 菜单里那一项变成「locked by flag」→ on 一律删键，不写 "on"。
 */
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonStateGuarded } from "./state-file.js";

export const SKILL_STATES = ["on", "off", "name-only", "user-invocable-only"] as const;
export type SkillState = (typeof SKILL_STATES)[number];
export type AgentSettings = Record<string, unknown>;

export const isSkillState = (v: unknown): v is SkillState => typeof v === "string" && (SKILL_STATES as readonly string[]).includes(v);

/** 技能调用名：个人技能 `name`，插件 / 同步 `前缀:name`。挡掉路径分隔、空白和引号，它会进 JSON 键和日志 */
export const isSkillName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);

/** registry 名（agent-xxx，历史上有中文名）或 master；只挡会逃出目录的写法 */
export function isSettingsAgentName(name: string): boolean {
  return !!name && name.length <= 128 && !/[/\\\0]/.test(name) && !name.startsWith(".");
}

export function agentSettingsPath(agent: string): string {
  if (!isSettingsAgentName(agent)) throw new Error(`非法的 agent 名: ${JSON.stringify(agent)}`);
  return statePath("agent-settings", `${agent}.json`);
}

const isPlainObject = (v: unknown): v is AgentSettings => !!v && typeof v === "object" && !Array.isArray(v);

/** 读者用：不存在 / 损坏都当空（损坏报一次）。写者别拿它的结果去写 */
export function readAgentSettings(agent: string): AgentSettings {
  const path = agentSettingsPath(agent);
  const r = readJsonStateSync(path, isPlainObject);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "agent-settings");
  return r.status === "ok" ? (r.data as AgentSettings) : {};
}

/** skillOverrides 里合法的条目（脏值丢掉，不让一个坏条目拖垮整张表） */
export function skillOverridesOf(settings: AgentSettings): Record<string, Exclude<SkillState, "on">> {
  const raw = settings.skillOverrides;
  const out: Record<string, Exclude<SkillState, "on">> = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isSkillName(k) && isSkillState(v) && v !== "on") out[k] = v;
  return out;
}

/** 纯函数：改一个技能的档位。on = 删键；表空了连 skillOverrides 键一起删；其它键原样保留 */
export function applySkillOverride(settings: AgentSettings, skill: string, state: SkillState): AgentSettings {
  const next: AgentSettings = { ...settings };
  const table = { ...(isPlainObject(settings.skillOverrides) ? settings.skillOverrides : {}) };
  if (state === "on") delete table[skill];
  else table[skill] = state;
  if (Object.keys(table).length) next.skillOverrides = table;
  else delete next.skillOverrides;
  return next;
}

/** 写者（manager）：磁盘上是坏文件就拒写；改完为空就删文件，免得每次启动白带一个空 --settings */
export async function setSkillOverride(agent: string, skill: string, state: SkillState): Promise<AgentSettings> {
  const path = agentSettingsPath(agent);
  const cur = readJsonStateSync(path, isPlainObject);
  const base = cur.status === "ok" ? (cur.data as AgentSettings) : {};
  const next = applySkillOverride(base, skill, state);
  if (Object.keys(next).length === 0 && cur.status !== "corrupt") {
    if (existsSync(path)) unlinkSync(path);
    return next;
  }
  await writeJsonStateGuarded(path, next, { validate: isPlainObject, trailingNewline: true });
  return next;
}

/** kill 时删、rename 时跟着挪；文件不在是常态（大多数 agent 没改过设置） */
export function removeAgentSettings(agent: string): void {
  const path = agentSettingsPath(agent);
  if (existsSync(path)) unlinkSync(path);
}
export function renameAgentSettings(from: string, to: string): void {
  const src = agentSettingsPath(from);
  if (existsSync(src)) renameSync(src, agentSettingsPath(to));
}

/** 生产的启动参数：文件在、能解析、非空才带路径（沙箱另走 sandboxLaunchArgs 合成一份内联 JSON）。纯函数 */
export function settingsLaunchArgs(own: { path: string | null; settings: AgentSettings | null }): string[] {
  return own.path && own.settings && Object.keys(own.settings).length ? ["--settings", own.path] : [];
}

/** 给启动器：读这个 agent 的设置文件（损坏 / 不存在 → null，不带 flag，宁可不带也不能让 CC 启动失败） */
export function launchSettingsFor(agent: string | undefined): { path: string | null; settings: AgentSettings | null } {
  if (!agent || !isSettingsAgentName(agent)) return { path: null, settings: null };
  const path = agentSettingsPath(agent);
  const r = readJsonStateSync(path, isPlainObject);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "agent-settings");
  return r.status === "ok" ? { path, settings: r.data as AgentSettings } : { path: null, settings: null };
}

/** 所有 agent 的 skillOverrides（技能库页「在哪些 agent 里关着」）：{ agent: { skill: 档位 } }，没有覆盖的 agent 不出现 */
export function allSkillOverrides(): Record<string, Record<string, Exclude<SkillState, "on">>> {
  let names: string[];
  try {
    names = readdirSync(statePath("agent-settings")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return {}; // 目录不在：还没有任何 agent 改过技能
  }
  const out: Record<string, Record<string, Exclude<SkillState, "on">>> = {};
  for (const n of names.filter(isSettingsAgentName)) {
    const o = skillOverridesOf(readAgentSettings(n));
    if (Object.keys(o).length) out[n] = o;
  }
  return out;
}

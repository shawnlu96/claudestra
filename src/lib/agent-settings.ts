/**
 * 每个 Claude Code agent 一份设置文件 `<state>/agent-settings/<registry 名>.json`，启动时读出来以内联 JSON 传给 `--settings`
 * （lib/claude-launch.ts）。现在只放 skillOverrides（按 agent 启停技能），读写按 key 合并，以后按 agent 切源等键放进来互不干扰。
 * 写者只有 manager（skill-toggle）；bridge 只读。不碰全局 ~/.claude/settings.json：CC Switch 切供应商会整份重写它。
 *
 * 实测（CC 2.1.283，docs 02-03 附录 C2）：
 * - `--settings <路径>` 指向的文件不存在时 CC 直接报错退出 → 不传路径传内容：生成命令到 CC 读文件之间文件被删 / 挪也起得来；
 * - 会话运行中改文件不生效（/reload-skills 也不行），重启（含 --resume）后生效 → 界面只提示「重启后生效」；
 * - 显式写 "on" 会让 /skills 菜单里那一项变成「locked by flag」→ on 一律删键，不写 "on"。
 */
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonStateGuarded } from "./state-file.js";

export const SKILL_STATES = ["on", "off", "name-only", "user-invocable-only"] as const;
export type SkillState = (typeof SKILL_STATES)[number];
export type AgentSettings = Record<string, unknown>;

/** 进启动命令行的键（白名单）：设置文件里手写了别的（比如 env 里的密钥）也不会出现在 ps 里 */
const LAUNCH_KEYS = ["skillOverrides"] as const;
/** 内联 JSON 的上限：tmux 单条命令约 16KB 就发不出去（启动命令里还有 purpose、project 上下文等），留一半余量 */
export const MAX_LAUNCH_SETTINGS_BYTES = 8192;
const launchPart = (s: AgentSettings): AgentSettings => Object.fromEntries(LAUNCH_KEYS.filter((k) => k in s).map((k) => [k, s[k]]));

export const isSkillState = (v: unknown): v is SkillState => typeof v === "string" && (SKILL_STATES as readonly string[]).includes(v);

/** 技能调用名：个人技能 `name`，插件 / 同步 `前缀:name`。挡掉路径分隔、空白和引号（会进 JSON 键和日志）；首字符要字母数字，顺带挡掉 __proto__ */
export const isSkillName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

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

/**
 * 写者（manager）：磁盘上是坏文件就拒写；改完为空就删文件，免得每次启动白带一个空 --settings。
 * aliases：同一个技能的别名键一并清掉（同步技能的裸名写法，CC 两种都认，留着会和界面上的档位对不上）。
 */
export async function setSkillOverride(agent: string, skill: string, state: SkillState, aliases: string[] = []): Promise<AgentSettings> {
  const path = agentSettingsPath(agent);
  const cur = readJsonStateSync(path, isPlainObject);
  const base = cur.status === "ok" ? (cur.data as AgentSettings) : {};
  const next = applySkillOverride(aliases.reduce((acc, a) => applySkillOverride(acc, a, "on"), base), skill, state);
  const bytes = Buffer.byteLength(JSON.stringify(launchPart(next)));
  if (bytes > MAX_LAUNCH_SETTINGS_BYTES) throw new Error(`技能覆盖太多了（${bytes} 字节，上限 ${MAX_LAUNCH_SETTINGS_BYTES}）：启动命令会超过 tmux 的长度上限，先把用不着的调回「开」`);
  if (Object.keys(next).length === 0 && cur.status !== "corrupt") {
    if (existsSync(path)) unlinkSync(path);
    return next;
  }
  await writeJsonStateGuarded(path, next, { validate: isPlainObject, trailingNewline: true });
  return next;
}

/**
 * remove（永久删除）时删；全新 agent（create、resume / takeover 起新名字）等 registry 落盘后删同名旧文件（启动时本来就不带）；rename 时跟着挪。
 * 都在 registry 已经落盘之后调：失败只报警、不抛，别让一个残留文件把命令的后半截（频道清理、rescan）断掉。
 */
export function removeAgentSettings(agent: string): void {
  try {
    const path = agentSettingsPath(agent);
    if (existsSync(path)) unlinkSync(path);
  } catch (e) {
    console.error(`⚠ 删除 agent 设置文件失败（${agent}）：${(e as Error).message}`);
  }
}
/**
 * 首次 rename：源文件不在时也要删掉目标位置的旧文件（改名到一个删过的名字，不能继承那个旧 agent 的开关）。
 * 补跑（resume）：只在源文件还在、且旧名没被新 agent 占用时挪，永远不删目标——上次可能已经挪过去了，旧名的文件也可能是新 agent 的。
 */
export function renameAgentSettings(from: string, to: string, resume?: { oldTaken: boolean }): void {
  try {
    const src = agentSettingsPath(from);
    if (resume) {
      if (!resume.oldTaken && existsSync(src)) renameSync(src, agentSettingsPath(to));
    } else if (existsSync(src)) renameSync(src, agentSettingsPath(to));
    else removeAgentSettings(to);
  } catch (e) {
    console.error(`⚠ 迁移 agent 设置文件失败（${from} → ${to}）：${(e as Error).message}`);
  }
}

/** 生产的启动参数：非空就以内联 JSON 传（沙箱另走 sandboxLaunchArgs，和沙箱覆盖合成一份）。只收 launchSettingsFor 过滤过的。纯函数 */
export function settingsLaunchArgs(settings: AgentSettings): string[] {
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
}

/** 给启动器：这个 agent 设置里白名单内的键（损坏 / 不存在 → {}，不带 flag；宁可不带也不能让 CC 启动失败） */
export function launchSettingsFor(agent: string | undefined): AgentSettings {
  return agent && isSettingsAgentName(agent) ? launchPart(readAgentSettings(agent)) : {};
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

/**
 * CC 自己的设置文件里的 skillOverrides（全局 ~/.claude/settings.json、项目 .claude/settings.json / settings.local.json）。
 * 这里不写它们，只拿来在界面上标出「那边关了」：--settings 里删键开不回来。读不到 / 坏了都当没有。
 */
export function outsideSkillOverrides(cwd: string | null, home = homedir()): Array<{ source: "user" | "project" | "local"; overrides: Record<string, string> }> {
  const files: Array<["user" | "project" | "local", string]> = [["user", join(home, ".claude", "settings.json")]];
  // cwd 就是家目录时，项目设置和全局设置是同一个文件，只补读 settings.local.json
  if (cwd && resolve(cwd) !== resolve(home)) files.push(["project", join(cwd, ".claude", "settings.json")]);
  if (cwd) files.push(["local", join(cwd, ".claude", "settings.local.json")]);
  const out: Array<{ source: "user" | "project" | "local"; overrides: Record<string, string> }> = [];
  for (const [source, path] of files) {
    const r = readJsonStateSync(path, isPlainObject);
    const o = r.status === "ok" ? skillOverridesOf(r.data as AgentSettings) : {};
    if (Object.keys(o).length) out.push({ source, overrides: o });
  }
  return out;
}

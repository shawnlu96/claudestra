/**
 * Slash Command Registry
 *
 * 维护四种来源的 skill + CC built-in 命令的并集：
 *   - userSkills        (全局，所有 agent 可用)
 *   - pluginSkills      (全局，所有 agent 可用)
 *   - nativeSkills      (CC 打包，所有 agent 可用)
 *   - builtinCommands   (硬编码 Discord-friendly 内置命令，所有 agent 可用)
 *   - projectSkills[X]  (只对 agent X 可用)
 *
 * Discord slash command 列表 = 全局 union（因为 Discord 命令是 guild-level，
 * 不能 per-channel 注册）。当用户在 channel C 触发 /foo 时，过滤逻辑决定
 * 是否真的发给 agent，发不了就直接回 ephemeral 消息。
 */

import {
  type SkillDef,
  discoverUserSkills,
  discoverPluginSkills,
  discoverProjectSkills,
  NATIVE_SKILLS,
} from "../lib/skills.js";
import { BUILTIN_COMMANDS, type BuiltinCmd } from "./slash-catalog.js";

interface RegistryState {
  userSkills: Map<string, SkillDef>;     // discordName -> def
  pluginSkills: Map<string, SkillDef>;
  nativeSkills: Map<string, SkillDef>;
  projectSkills: Map<string, Map<string, SkillDef>>; // agentName -> (discordName -> def)
  builtins: Map<string, BuiltinCmd>;     // name -> cmd
}

const state: RegistryState = {
  userSkills: new Map(),
  pluginSkills: new Map(),
  nativeSkills: new Map(),
  projectSkills: new Map(),
  builtins: new Map(BUILTIN_COMMANDS.map((c) => [c.name, c])),
};

/** 首次 / 全量扫描（不含项目级）。bridge 启动时调一次。 */
export async function scanGlobal(): Promise<void> {
  const [users, plugins] = await Promise.all([
    discoverUserSkills(),
    discoverPluginSkills(),
  ]);
  state.userSkills.clear();
  for (const s of users) state.userSkills.set(s.discordName, s);
  state.pluginSkills.clear();
  for (const s of plugins) state.pluginSkills.set(s.discordName, s);
  state.nativeSkills.clear();
  for (const s of NATIVE_SKILLS) state.nativeSkills.set(s.discordName, s);
}

/** 扫某个 agent 的项目目录 + 纳入 registry */
export async function scanProject(agentName: string, cwd: string): Promise<void> {
  const items = await discoverProjectSkills(agentName, cwd);
  const map = new Map<string, SkillDef>();
  for (const s of items) map.set(s.discordName, s);
  state.projectSkills.set(agentName, map);
}

/** 清除某个 agent 的项目级 skill（kill 时调） */
export function clearProject(agentName: string): void {
  state.projectSkills.delete(agentName);
}

/**
 * 返回所有可注册到 Discord 的命令定义（供 bridge 启动 / 重注册用）。
 * 去重规则：同名时 builtin > native > plugin > user > project；重复的后者被覆盖不注册。
 */
export function allRegistrableCommands(): Array<
  | { kind: "builtin"; cmd: BuiltinCmd }
  | { kind: "skill"; skill: SkillDef }
> {
  const seen = new Set<string>();
  const out: Array<
    | { kind: "builtin"; cmd: BuiltinCmd }
    | { kind: "skill"; skill: SkillDef }
  > = [];

  for (const cmd of state.builtins.values()) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push({ kind: "builtin", cmd });
  }
  // 顺序：native > plugin > user > project，冲突时后者被跳
  const skillSources: Array<Iterable<SkillDef>> = [
    state.nativeSkills.values(),
    state.pluginSkills.values(),
    state.userSkills.values(),
  ];
  for (const src of skillSources) {
    for (const skill of src) {
      if (seen.has(skill.discordName)) continue;
      seen.add(skill.discordName);
      out.push({ kind: "skill", skill });
    }
  }
  for (const agentSkills of state.projectSkills.values()) {
    for (const skill of agentSkills.values()) {
      if (seen.has(skill.discordName)) continue;
      seen.add(skill.discordName);
      out.push({ kind: "skill", skill });
    }
  }
  return out;
}

/**
 * 在 channel C（绑定 agent A）触发 /name args，判断能否执行 + 返回要发给 CC 的命令文本。
 *
 * 返回：
 *   { ok: true, cc_text: "/cmd args", scope: ... }
 *   { ok: false, reason: "skill 在该 agent 不可用" }
 */
export function resolveInvocation(
  discordName: string,
  agentName: string | null,
  vals: Record<string, string>
): { ok: true; ccText: string; scope: string } | { ok: false; reason: string } {
  // 1. built-in 永远可用
  const builtin = state.builtins.get(discordName);
  if (builtin) {
    const args = builtin.argBuilder(vals);
    return { ok: true, ccText: `/${builtin.invokeName}${args}`, scope: "builtin" };
  }

  // 2. 聚合可用 skill（按 agent 过滤项目级）
  const candidates: SkillDef[] = [];
  const native = state.nativeSkills.get(discordName);
  if (native) candidates.push(native);
  const plugin = state.pluginSkills.get(discordName);
  if (plugin) candidates.push(plugin);
  const user = state.userSkills.get(discordName);
  if (user) candidates.push(user);
  if (agentName) {
    const projects = state.projectSkills.get(agentName);
    const proj = projects?.get(discordName);
    if (proj) candidates.push(proj);
  }

  if (candidates.length === 0) {
    // 全局不存在
    return { ok: false, reason: `/${discordName} 不是已知命令` };
  }

  // 如果候选只来自其他 agent 的项目级 skill → 当前 agent 不可用
  // （注意 candidates 已经是过滤过的，只要有就说明全局或当前 agent 可用）
  const picked = candidates[0];
  const argText = (vals.args || "").trim();
  const args = argText ? ` ${argText}` : "";
  return { ok: true, ccText: `/${picked.invokeName}${args}`, scope: picked.scope };
}

/** 判断 discordName 是不是某个 agent 独有的 project skill，当前 agent 却没有 → 给友好错误 */
export function isProjectSkillForOtherAgent(discordName: string, agentName: string | null): string | null {
  for (const [other, skills] of state.projectSkills.entries()) {
    if (other === agentName) continue;
    if (skills.has(discordName)) return other;
  }
  return null;
}

/** 快速 dump（调试用） */
export function debugSnapshot() {
  return {
    user: [...state.userSkills.keys()],
    plugin: [...state.pluginSkills.keys()],
    native: [...state.nativeSkills.keys()],
    project: Object.fromEntries(
      [...state.projectSkills.entries()].map(([k, v]) => [k, [...v.keys()]])
    ),
    builtins: [...state.builtins.keys()],
  };
}

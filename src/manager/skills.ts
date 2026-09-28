/**
 * `skill-toggle <agent> <skill> on|off|name-only|user-invocable-only`：按 agent 启停技能（台账 i03 第一期）。manager 是唯一写者，
 * CLI / 网页（bridge/local-api/agent-skills.ts）共用。改完都要重启才生效（lib/agent-settings.ts 顶部的实测），这里不自动重启。
 * - Claude Code（含 master）：agent 设置文件的 skillOverrides，四档都支持；
 * - Pi：能力档案 piEnv.skills，只有 base=minimal 才能逐个管，且只有开 / 关；
 * - Codex：本期不支持。
 */
import { isSkillName, isSkillState, readAgentSettings, skillOverridesOf, skillTableOf, writeSkillChanges, type SkillState } from "../lib/agent-settings.js";
import { piCandidates, piParentEntryFor, piSkillEntryMatches, skillWrites } from "../lib/agent-skills.js";
import { normalizePiEnvProfile } from "../lib/pi-env.js";
import { agentRuntime, isMasterAgent } from "../lib/registry.js";
import { expandHome, localSkillLibrary } from "../lib/skill-library.js";
import { loadRegistry, normalizeName, output, saveRegistry, type Registry } from "./core.js";

const USAGE = "usage: skill-toggle <agent|master> <skill> on|off|name-only|user-invocable-only";

export async function cmdSkillToggle(args: string[]): Promise<void> {
  const [name, skill, state] = args;
  if (!name || !skill || !state) return output({ ok: false, error: USAGE });
  if (!isSkillName(skill)) return output({ ok: false, error: `技能名不合法: ${JSON.stringify(skill)}` });
  if (!isSkillState(state)) return output({ ok: false, error: `未知档位 "${state}"。${USAGE}` });
  if (isMasterAgent(normalizeName(name))) return toggleClaude("master", null, skill, state); // agent-master / Master 也归到 launcher 读的 master.json
  const reg = await loadRegistry();
  const key = normalizeName(name);
  const info = reg.agents[key];
  if (!info) return output({ ok: false, error: `${key} 不在 registry` });
  // 做到一半的 create / rename / kill：rename 补跑会用旧名的文件覆盖新名的，这时写进来的开关会丢（manager repair 或重跑那条命令收尾）
  if (info.pending) return output({ ok: false, error: `${key} 的 ${info.pending.op} 还没做完，等它收尾（或 manager repair）再调技能` });
  const rt = agentRuntime(info);
  if (rt === "codex") return output({ ok: false, error: "Codex agent 暂不支持按 agent 启停技能（它的技能目录是全局的）" });
  if (rt === "pi") return togglePi(reg, key, skill, state);
  return toggleClaude(key, info.cwd ? expandHome(String(info.cwd)) : null, skill, state);
}

async function toggleClaude(agent: string, cwd: string | null, skill: string, state: SkillState): Promise<void> {
  // 按 CC 的查键规则算要写哪些键（同名的个人 / 项目技能与同步技能互相牵连，lib/agent-skills.ts skillWrites）
  const { skills } = await localSkillLibrary(cwd ? { cwd, runtime: "claude-code" } : undefined);
  const changes = skillWrites(skill, state, skills, cwd, skillTableOf(readAgentSettings(agent)));
  const next = await writeSkillChanges(agent, changes).catch((e: Error) => e);
  if (next instanceof Error) return output({ ok: false, error: next.message });
  output({
    ok: true,
    agent,
    skill,
    state,
    overrides: skillOverridesOf(next),
    restartRequired: true,
    hint: `重启后生效：manager restart ${agent === "master" ? "--include-master" : agent.replace(/^agent-/, "")}`,
  });
}

async function togglePi(reg: Registry, key: string, skill: string, state: SkillState): Promise<void> {
  const info = reg.agents[key];
  const env = normalizePiEnvProfile(info.piEnv);
  if (env.base !== "minimal") {
    return output({ ok: false, error: "这个 Pi agent 是「继承全局」档，会加载全部技能；先 pi-env-set <agent> --base minimal 才能逐个管" });
  }
  if (state !== "on" && state !== "off") return output({ ok: false, error: "Pi 的技能只有开 / 关两档" });
  const cwd = info.cwd ? expandHome(String(info.cwd)) : null;
  const target = piCandidates((await localSkillLibrary(cwd ? { cwd, runtime: "pi" } : undefined)).skills, cwd).find((s) => s.name === skill);
  const parent = target && piParentEntryFor(env.skills ?? [], target);
  if (parent && state === "off") return output({ ok: false, error: `「${skill}」是跟着整个目录 ${parent} 一起加载的，单独关不掉；要关就先把这一项从档案里拿掉（pi-env-set --reset 后重加）` });
  const kept = (env.skills ?? []).filter((e) => !(target ? piSkillEntryMatches(e, target) : e.endsWith(`/${skill}`)));
  if (state === "on" && !parent) {
    if (!target) return output({ ok: false, error: `Pi 的技能目录里没有「${skill}」` });
    kept.push(target.dir);
  }
  const cleaned = normalizePiEnvProfile({ ...env, skills: kept });
  if (Object.keys(cleaned).length) reg.agents[key].piEnv = cleaned as Record<string, unknown>;
  else delete reg.agents[key].piEnv;
  await saveRegistry(reg);
  output({ ok: true, agent: key, skill, state, piSkills: cleaned.skills ?? [], restartRequired: true, hint: `重启后生效：manager restart ${key.replace(/^agent-/, "")}` });
}

/**
 * 「这个 agent 能看到哪些技能、各是什么档位」：会话详情里的技能开关（bridge 只读）与 manager skill-toggle（Pi 找技能目录）共用。
 * 事实源各归各：Claude Code 看 agent 设置文件的 skillOverrides（lib/agent-settings.ts），Pi 看能力档案 piEnv.skills
 * （只有 base=minimal 才是白名单，inherit 档 Pi 会加载全部技能、没有逐个关的开关），Codex 本期不支持。纯函数，tests/agent-skills.test.ts。
 */
import { basename, resolve } from "node:path";
import type { SkillState } from "./agent-settings.js";
import type { LibrarySkill } from "./skill-library.js";
import type { PiEnvProfile } from "./pi-env.js";
import type { AgentRuntime } from "./registry.js";

interface AgentSkillRow {
  name: string;
  description: string;
  /** 设置文件里有、技能库里已经找不到的（删掉 / 改名的技能）：scope = "missing"，留一行好把它开回来 */
  scope: LibrarySkill["scope"] | "missing";
  dir: string | null;
  state: SkillState;
  userInvocable: boolean;
  modelInvocable: boolean;
}

export type AgentSkillView =
  | { runtime: "claude-code"; supported: true; rows: AgentSkillRow[] }
  | { runtime: "pi"; supported: boolean; reason?: "inherit"; rows: AgentSkillRow[] }
  | { runtime: "codex"; supported: false; reason: "codex"; rows: AgentSkillRow[] };

const row = (s: LibrarySkill, state: SkillState): AgentSkillRow => ({
  name: s.name,
  description: s.description,
  scope: s.scope,
  dir: s.dir,
  state,
  userInvocable: s.userInvocable,
  modelInvocable: s.modelInvocable,
});

const byName = (a: AgentSkillRow, b: AgentSkillRow) => a.name.localeCompare(b.name);

/** 项目技能只算这个 agent 工作目录的；cwd 为空（大总管）只看个人 / 插件 / 同步 */
const visibleTo = (s: LibrarySkill, rt: AgentRuntime, cwd: string | null) =>
  s.runtime === rt && (s.scope !== "project" || (!!cwd && s.project === cwd));

/** Claude Code：被同名盖过的不列（CC 只认赢家）；overrides 里技能库找不到的补一行 missing */
function claudeSkillRows(skills: LibrarySkill[], cwd: string | null, overrides: Record<string, SkillState>): AgentSkillRow[] {
  const rows = skills.filter((s) => visibleTo(s, "claude-code", cwd) && !s.shadowedBy).map((s) => row(s, overrides[s.name] ?? "on"));
  const seen = new Set(rows.map((r) => r.name));
  for (const [name, state] of Object.entries(overrides)) {
    if (seen.has(name)) continue;
    rows.push({ name, description: "", scope: "missing", dir: null, state, userInvocable: true, modelInvocable: true });
  }
  return rows.sort(byName);
}

/** piEnv.skills 的一项是不是这个技能（档案里存的是路径，按真实目录或目录名认） */
export function piSkillEntryMatches(entry: string, skill: { name: string; dir: string }): boolean {
  return resolve(entry) === resolve(skill.dir) || basename(resolve(entry)) === skill.name;
}

/** Pi 在这个 agent 上可选的技能（同名多处时按 项目 > 个人 > 共享目录 取一个，与 Pi 的目录发现顺序无关，只为有确定答案） */
export function piCandidates(skills: LibrarySkill[], cwd: string | null): LibrarySkill[] {
  const rank = (s: LibrarySkill) => (s.scope === "project" ? 0 : s.scope === "personal" ? 1 : 2);
  const pick = new Map<string, LibrarySkill>();
  for (const s of skills.filter((x) => visibleTo(x, "pi", cwd)).sort((a, b) => rank(a) - rank(b))) {
    if (!pick.has(s.name)) pick.set(s.name, s);
  }
  return [...pick.values()];
}

function piSkillRows(skills: LibrarySkill[], cwd: string | null, env: PiEnvProfile): AgentSkillRow[] {
  const minimal = env.base === "minimal";
  const listed = env.skills ?? [];
  return piCandidates(skills, cwd)
    .map((s) => row(s, !minimal || listed.some((e) => piSkillEntryMatches(e, s)) ? "on" : "off"))
    .sort(byName);
}

export function agentSkillView(
  runtime: AgentRuntime,
  skills: LibrarySkill[],
  ctx: { cwd: string | null; overrides: Record<string, SkillState>; piEnv: PiEnvProfile },
): AgentSkillView {
  if (runtime === "codex") return { runtime, supported: false, reason: "codex", rows: [] };
  if (runtime === "pi") {
    const rows = piSkillRows(skills, ctx.cwd, ctx.piEnv);
    return ctx.piEnv.base === "minimal" ? { runtime, supported: true, rows } : { runtime, supported: false, reason: "inherit", rows };
  }
  return { runtime: "claude-code", supported: true, rows: claudeSkillRows(skills, ctx.cwd, ctx.overrides) };
}

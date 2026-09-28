/**
 * 「这个 agent 能看到哪些技能、各是什么档位」：会话详情里的技能开关（bridge 只读）与 manager skill-toggle（Pi 找技能目录）共用。
 * 事实源各归各：Claude Code 看 agent 设置文件的 skillOverrides（lib/agent-settings.ts），Pi 看能力档案 piEnv.skills
 * （只有 base=minimal 才是白名单，inherit 档 Pi 会加载全部技能、没有逐个关的开关），Codex 本期不支持。纯函数，tests/agent-skills.test.ts。
 */
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
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
  /** 项目 / 全局 settings 里对它的 skillOverrides（这里管不到；CC 里 --settings 删键开不回来） */
  outside?: Array<{ source: OutsideSource; state: string }>;
  /** Pi：跟着 piEnv.skills 里整个父目录一起加载的，单独关不掉（值是那一项） */
  lockedBy?: string;
}

type OutsideSource = "user" | "project" | "local";
export type OutsideOverrides = Array<{ source: OutsideSource; overrides: Record<string, string> }>;

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

const SYNCED_PREFIX = "anthropic-skills:";

/**
 * 同步技能的别名键：CC 对 `anthropic-skills:docx` 和裸名 `docx` 都认（附录 C2 实测）。只有没有同名的个人 / 项目 / 插件技能时
 * 裸名才算它的别名；有同名的，裸名归那个技能，不能拿来算、也不能顺手删。
 */
export function syncedAliases(skill: string, skills: LibrarySkill[], cwd: string | null): string[] {
  if (!skill.startsWith(SYNCED_PREFIX)) return [];
  const bare = skill.slice(SYNCED_PREFIX.length);
  return skills.some((s) => visibleTo(s, "claude-code", cwd) && s.scope !== "synced" && s.name === bare) ? [] : [bare];
}

const outsideOf = (keys: string[], outside: OutsideOverrides) =>
  outside.flatMap((o) => keys.filter((k) => k in o.overrides).map((k) => ({ source: o.source, state: o.overrides[k] })));

/** Claude Code：被同名盖过的不列（CC 只认赢家）；overrides 里技能库找不到、也不是别名的补一行 missing */
function claudeSkillRows(skills: LibrarySkill[], cwd: string | null, overrides: Record<string, SkillState>, outside: OutsideOverrides): AgentSkillRow[] {
  const consumed = new Set<string>();
  const rows = skills
    .filter((s) => visibleTo(s, "claude-code", cwd) && !s.shadowedBy)
    .map((s) => {
      const keys = [s.name, ...syncedAliases(s.name, skills, cwd)];
      keys.forEach((k) => consumed.add(k));
      const hit = keys.find((k) => overrides[k]);
      const out = outsideOf(keys, outside);
      return { ...row(s, hit ? overrides[hit] : "on"), ...(out.length ? { outside: out } : {}) };
    });
  for (const [name, state] of Object.entries(overrides)) {
    if (consumed.has(name)) continue;
    rows.push({ name, description: "", scope: "missing", dir: null, state, userInvocable: true, modelInvocable: true });
  }
  return rows.sort(byName);
}

/** 档案里的一项 → 真实路径：展开 ~；写成 SKILL.md 文件的按它所在目录算 */
const entryPath = (entry: string) => {
  const p = resolve(entry.replace(/^~(?=$|\/)/, homedir()));
  return basename(p) === "SKILL.md" ? dirname(p) : p;
};

/** piEnv.skills 的一项是不是这个技能（档案里存的是路径：目录、SKILL.md 文件都认，再退一步按目录名认） */
export function piSkillEntryMatches(entry: string, skill: { name: string; dir: string }): boolean {
  const p = entryPath(entry);
  return p === resolve(skill.dir) || basename(p) === skill.name;
}

/** 这一项是装着多个技能的父目录、把这个技能一起带进来了（单独关不掉） */
export function piParentEntryFor(entries: string[], skill: { dir: string }): string | undefined {
  return entries.find((e) => entryPath(e) === dirname(resolve(skill.dir)));
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
    .map((s) => {
      const parent = minimal ? piParentEntryFor(listed, s) : undefined;
      const on = !minimal || !!parent || listed.some((e) => piSkillEntryMatches(e, s));
      return { ...row(s, on ? "on" : "off"), ...(parent ? { lockedBy: parent } : {}) };
    })
    .sort(byName);
}

export function agentSkillView(
  runtime: AgentRuntime,
  skills: LibrarySkill[],
  ctx: { cwd: string | null; overrides: Record<string, SkillState>; piEnv: PiEnvProfile; outside?: OutsideOverrides },
): AgentSkillView {
  if (runtime === "codex") return { runtime, supported: false, reason: "codex", rows: [] };
  if (runtime === "pi") {
    const rows = piSkillRows(skills, ctx.cwd, ctx.piEnv);
    return ctx.piEnv.base === "minimal" ? { runtime, supported: true, rows } : { runtime, supported: false, reason: "inherit", rows };
  }
  return { runtime: "claude-code", supported: true, rows: claudeSkillRows(skills, ctx.cwd, ctx.overrides, ctx.outside ?? []) };
}

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
  outside?: Array<{ source: OutsideSource; key: string; state: string }>;
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

/*
 * CC 怎么查一个技能的档位（2.1.283 读码 + 实测，docs 02-03 附录 C2）：先按全名查键，查到任何值（含 "on"）就停；查不到再按裸名查。
 * 同步技能全名 `anthropic-skills:x`、裸名 x；个人 / 项目技能全名就是 x。所以裸键 x 会同时关掉个人 / 项目 x 和同步 x，
 * 想只关前者，得给同步 x 显式钉一个 `anthropic-skills:x: "on"`（它在 CC /skills 菜单里会显示 locked by flag，只在要钉时写）。
 */
const visibleClaude = (skills: LibrarySkill[], cwd: string | null) => skills.filter((s) => visibleTo(s, "claude-code", cwd) && !s.shadowedBy);
const hasNamesake = (bare: string, visible: LibrarySkill[]) => visible.some((s) => s.scope !== "synced" && s.name === bare);

/** 界面上改一行 → 要写的键（null = 删键）。纯函数，manager skill-toggle 用；table 是这个 agent 现在的表（含钉住的 "on"） */
export function skillWrites(
  skill: string, state: SkillState, skills: LibrarySkill[], cwd: string | null, table: Record<string, SkillState>,
): Record<string, SkillState | null> {
  const visible = visibleClaude(skills, cwd);
  if (skill.startsWith(SYNCED_PREFIX)) {
    const bare = skill.slice(SYNCED_PREFIX.length);
    // 没有同名技能：裸键是它自己的旧写法，一并删；有：裸键归那个技能，它关着时这边要开就得钉住
    if (!hasNamesake(bare, visible)) return { [bare]: null, [skill]: state === "on" ? null : state };
    return { [skill]: state !== "on" ? state : table[bare] && table[bare] !== "on" ? "on" : null };
  }
  const twin = SYNCED_PREFIX + skill;
  const twinVisible = visible.some((s) => s.scope === "synced" && s.name === twin);
  if (twinVisible && !hasNamesake(skill, visible)) return skillWrites(twin, state, skills, cwd, table); // 裸名只指同步那个（CLI 手敲）
  const out: Record<string, SkillState | null> = { [skill]: state === "on" ? null : state };
  if (twinVisible) {
    if (state !== "on" && table[twin] === undefined) out[twin] = "on"; // 同步的那个界面上开着：钉住，别被裸键连带关掉
    if (state === "on" && table[twin] === "on") out[twin] = null; // 不用再钉
  }
  return out;
}

const outsideOf = (keys: string[], outside: OutsideOverrides) =>
  outside.flatMap((o) => keys.filter((k) => k in o.overrides).map((k) => ({ source: o.source, key: k, state: o.overrides[k] })));

/** Claude Code：被同名盖过的不列（CC 只认赢家）；档位按 CC 的查法算；表里技能库找不到的非 on 键补一行 missing */
function claudeSkillRows(skills: LibrarySkill[], cwd: string | null, table: Record<string, SkillState>, outside: OutsideOverrides): AgentSkillRow[] {
  const consumed = new Set<string>();
  const visible = visibleClaude(skills, cwd);
  const rows = visible.map((s) => {
    const bare = s.scope === "synced" && s.name.startsWith(SYNCED_PREFIX) ? s.name.slice(SYNCED_PREFIX.length) : null;
    const keys = bare === null ? [s.name] : [s.name, bare]; // 同步技能的裸键不管归谁，CC 都会连带用到它
    consumed.add(s.name);
    if (bare !== null && !hasNamesake(bare, visible)) consumed.add(bare);
    const state = table[s.name] ?? (bare === null ? undefined : table[bare]) ?? "on";
    const out = outsideOf(keys, outside);
    return { ...row(s, state), ...(out.length ? { outside: out } : {}) };
  });
  for (const [name, state] of Object.entries(table)) {
    if (consumed.has(name) || state === "on") continue;
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

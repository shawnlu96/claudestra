/**
 * 本机的「有效技能清单」：每个技能从哪来（目录 / 插件 / 同步）、作用在哪（个人 / 项目）、哪个 runtime 看得见、
 * 同名时谁生效。设置 · 技能页只读展示；以后的启停 / 安装都以它为准（codex 复核 i03：启停不能只看软链，原生目录、
 * 插件、多个搜索根都会继续提供同名技能，得先把「来源 + 作用域 + runtime」列清楚）。
 *
 * 搜索根（2026-09-28 核对）：
 *   Claude Code  ~/.claude/skills（个人）· <项目>/.claude/skills · 插件 <installPath>/skills（名字带 插件名: 前缀）·
 *                ~/.claude/skills/synced/<账号>/（claude.ai 同步，调用名一律 anthropic-skills:<名>——2026-09-28 CC 2.1.281 实测，
 *                没撞名也带前缀）。同名：个人 > 项目；插件、同步都带前缀，和别的不冲突
 *   Codex        ~/.codex/skills · ~/.codex/skills/.system（自带）· ~/.agents/skills · <项目>/.agents/skills（codex 0.153 二进制里的路径）
 *   Pi           ~/.pi/agent/skills · settings.json 的 skills[] · ~/.agents/skills · <项目>/.pi/skills · <项目>/.agents/skills（lib/pi-env.ts）
 * Codex / Pi 的同名优先级没有文档，不猜，只标「同名还有 N 处」。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readPiGlobalEnv } from "./pi-env.js";
import { agentRuntime, readActiveAgents, type AgentRuntime } from "./registry.js";
import { REPO_ROOT } from "./repo-root.js";
import { readSkillMd } from "./skills.js";

type SkillRuntime = AgentRuntime;
type SkillScope = "personal" | "project" | "plugin" | "synced" | "system" | "shared";

export interface SkillRoot {
  runtime: SkillRuntime;
  scope: SkillScope;
  dir: string;
  /** 项目根（scope = project） */
  project?: string;
  /** 插件名（scope = plugin）：调用名是 `插件名:技能名` */
  plugin?: string;
}

export interface LibrarySkill {
  runtime: SkillRuntime;
  scope: SkillScope;
  /** 调用名（插件的带前缀） */
  name: string;
  description: string;
  dir: string;
  project?: string;
  /** 目录是软链时指向哪（真实路径） */
  linkTarget: string | null;
  /** 谁在管这个技能：软链进本仓库 skills/ = claudestra；进 CC Switch / ~/.agents 的主副本 = cc-switch */
  managedBy: "claudestra" | "cc-switch" | null;
  userInvocable: boolean;
  modelInvocable: boolean;
  /** 同名被谁盖过（只按 Claude Code 官方规则判）；undefined = 生效 */
  shadowedBy?: SkillScope;
  /** 同一 runtime 里同名的还有几处（Codex / Pi 优先级没文档，只报数） */
  sameNameElsewhere: number;
}

export interface RootEnv {
  home: string;
  /** 各 agent 的工作目录与 runtime（项目级技能按这个找） */
  agents: Array<{ cwd: string; runtime: SkillRuntime }>;
  /** Claude Code 已装插件（installed_plugins.json） */
  plugins: Array<{ name: string; installPath: string }>;
  /** Pi settings.json 里的 skills[] 额外目录 */
  piSkillPaths: string[];
}

/** 按环境列出所有搜索根（纯函数，不碰盘；synced 的账号子目录由 scan 时展开） */
export function skillRoots(env: RootEnv): SkillRoot[] {
  const h = env.home;
  const roots: SkillRoot[] = [
    { runtime: "claude-code", scope: "personal", dir: join(h, ".claude", "skills") },
    { runtime: "claude-code", scope: "synced", dir: join(h, ".claude", "skills", "synced") },
    ...env.plugins.map((p): SkillRoot => ({ runtime: "claude-code", scope: "plugin", dir: join(p.installPath, "skills"), plugin: p.name })),
    { runtime: "codex", scope: "personal", dir: join(h, ".codex", "skills") },
    { runtime: "codex", scope: "system", dir: join(h, ".codex", "skills", ".system") },
    { runtime: "codex", scope: "shared", dir: join(h, ".agents", "skills") },
    { runtime: "pi", scope: "personal", dir: join(h, ".pi", "agent", "skills") },
    ...env.piSkillPaths.map((dir): SkillRoot => ({ runtime: "pi", scope: "personal", dir })),
    { runtime: "pi", scope: "shared", dir: join(h, ".agents", "skills") },
  ];
  const seen = new Set<string>();
  for (const a of env.agents) {
    const dirs = a.runtime === "claude-code" ? [".claude/skills"] : a.runtime === "codex" ? [".agents/skills"] : [".pi/skills", ".agents/skills"];
    for (const d of dirs) {
      const key = `${a.runtime}|${join(a.cwd, d)}`;
      if (seen.has(key) || a.cwd === h) continue; // 家目录的 .claude/skills 就是个人技能，不重复算成项目
      seen.add(key);
      roots.push({ runtime: a.runtime, scope: "project", dir: join(a.cwd, d), project: a.cwd });
    }
  }
  return roots;
}

/** 软链目标是真实路径，比较的一方也得是（/var → /private/var、仓库目录本身是软链时对不上） */
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p; // 目录不在：原样比，反正也不会有软链指进去
  }
};

function managerOf(target: string | null, repoSkillsDir: string, home: string): LibrarySkill["managedBy"] {
  if (!target) return null;
  const under = (dir: string) => target.startsWith(real(dir) + "/");
  if (under(repoSkillsDir)) return "claudestra";
  if (under(join(home, ".cc-switch")) || under(join(home, ".agents", "skills"))) return "cc-switch";
  return null;
}

const listDirs = (dir: string) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return []; // 目录不在：这个根没有技能
  }
};

/** 扫一个根下的技能（synced 多一层账号目录） */
async function scanRoot(root: SkillRoot, repoSkillsDir: string, home: string): Promise<LibrarySkill[]> {
  const dirs = root.scope === "synced" ? listDirs(root.dir).map((acct) => join(root.dir, acct)) : [root.dir];
  const out: LibrarySkill[] = [];
  for (const base of dirs) {
    for (const entry of listDirs(base)) {
      if (root.scope === "personal" && root.runtime === "claude-code" && entry === "synced") continue;
      const dir = join(base, entry);
      const md = join(dir, "SKILL.md");
      if (!existsSync(md)) continue;
      const meta = await readSkillMd(md, entry);
      if (!meta) continue;
      let linkTarget: string | null = null;
      try {
        if (lstatSync(dir).isSymbolicLink()) linkTarget = realpathSync(dir);
      } catch { /* 断链：existsSync(md) 已经挡掉了，这里只可能是竞态，当普通目录 */ }
      out.push({
        runtime: root.runtime,
        scope: root.scope,
        name: root.plugin ? `${root.plugin}:${meta.name}` : root.scope === "synced" ? `anthropic-skills:${meta.name}` : meta.name,
        description: meta.description.slice(0, 300),
        dir,
        ...(root.project ? { project: root.project } : {}),
        linkTarget,
        managedBy: managerOf(linkTarget, repoSkillsDir, home),
        userInvocable: meta.userInvocable,
        modelInvocable: meta.modelInvocable,
        sameNameElsewhere: 0,
      });
    }
  }
  return out;
}

/** Claude Code 的同名规则：个人 > 项目（同一项目内）；插件、同步的带前缀，不跟别的撞（纯函数） */
const CC_RANK: Partial<Record<SkillScope, number>> = { personal: 3, project: 2 };
export function markShadowing(skills: LibrarySkill[]): LibrarySkill[] {
  const groups = new Map<string, LibrarySkill[]>();
  for (const s of skills) {
    const k = `${s.runtime}|${s.name}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const g of groups.values()) {
    for (const s of g) s.sameNameElsewhere = g.length - 1;
    if (g[0].runtime !== "claude-code" || g.length < 2) continue;
    for (const s of g) {
      const rank = CC_RANK[s.scope] ?? 0;
      // 项目技能只和同一项目的项目技能比；不同项目各管各的 agent，互不遮挡
      const winner = g.find((o) => o !== s && (CC_RANK[o.scope] ?? 0) > rank && (o.scope !== "project" || o.project === s.project));
      if (winner) s.shadowedBy = winner.scope;
    }
  }
  return skills;
}

export async function buildSkillLibrary(env: RootEnv, repoSkillsDir: string): Promise<{ roots: Array<SkillRoot & { exists: boolean }>; skills: LibrarySkill[] }> {
  const roots = skillRoots(env);
  const skills: LibrarySkill[] = [];
  for (const r of roots) skills.push(...(await scanRoot(r, repoSkillsDir, env.home)));
  return { roots: roots.map((r) => ({ ...r, exists: existsSync(r.dir) })), skills: markShadowing(skills) };
}

/** 从 Claude Code 的 installed_plugins.json 读已装插件（读不到 = 没插件） */
function readInstalledPlugins(home: string): RootEnv["plugins"] {
  try {
    const idx = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"));
    const out: RootEnv["plugins"] = [];
    for (const [key, insts] of Object.entries(idx?.plugins ?? {})) {
      for (const inst of Array.isArray(insts) ? insts : []) {
        if (typeof inst?.installPath === "string") out.push({ name: key.split("@")[0], installPath: inst.installPath });
      }
    }
    return out;
  } catch {
    return []; // 没装过插件时文件不存在；坏了也只是少列插件技能，不挡别的
  }
}

/** registry 里的 cwd 可能写成 ~/…，与技能库里的项目根比较前展开 */
export const expandHome = (p: string, home = homedir()) => p.replace(/^~(?=$|\/)/, home);

/**
 * 本机现状建一份技能库（设置 · 技能页、会话详情的技能开关、manager skill-toggle 共用）。
 * include：额外要扫项目技能的 agent（已停止的 agent 不在 active 列表里，看它自己的技能时要带上）。
 */
export async function localSkillLibrary(include?: { cwd: string; runtime: AgentRuntime }): Promise<Awaited<ReturnType<typeof buildSkillLibrary>>> {
  const home = homedir();
  const agents = (await readActiveAgents()).filter((a) => a.cwd).map((a) => ({ cwd: expandHome(a.cwd!, home), runtime: agentRuntime(a) }));
  if (include) agents.push(include); // skillRoots 按 runtime|目录去重，重复没关系
  return buildSkillLibrary({ home, agents, plugins: readInstalledPlugins(home), piSkillPaths: readPiGlobalEnv().skillPaths }, `${REPO_ROOT}/skills`);
}

/** 只留这些工作目录下的项目技能 / 项目搜索根（个人、插件、同步等不是项目的原样保留）：按凭据 scope 裁剪用 */
export function onlyProjects<T extends { scope: string; project?: string }>(items: T[], cwds: Set<string>): T[] {
  return items.filter((x) => x.scope !== "project" || (!!x.project && cwds.has(x.project)));
}

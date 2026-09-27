/**
 * 设置 ·「技能」页（components/settings/skills-section.tsx）：本机有效技能清单的筛选、排序与标签。
 * 数据：GET /api/v1/skills/library（bridge 的 src/lib/skill-library.ts）。纯函数，tests/web-skills-library.test.ts。
 */
export type SkillRuntime = "claude-code" | "codex" | "pi";
export type SkillScope = "personal" | "project" | "plugin" | "synced" | "system" | "shared";

export interface LibrarySkill {
  runtime: SkillRuntime;
  scope: SkillScope;
  name: string;
  description: string;
  dir: string;
  project?: string;
  linkTarget: string | null;
  managedBy: "claudestra" | "cc-switch" | null;
  userInvocable: boolean;
  modelInvocable: boolean;
  shadowedBy?: SkillScope;
  sameNameElsewhere: number;
}

export interface SkillRoot {
  runtime: SkillRuntime;
  scope: SkillScope;
  dir: string;
  exists: boolean;
  project?: string;
  plugin?: string;
}

export interface SkillLibrary {
  roots: SkillRoot[];
  skills: LibrarySkill[];
}

export const RUNTIME_LABEL: Record<SkillRuntime, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };
export const SCOPE_LABEL: Record<SkillScope, string> = {
  personal: "个人",
  project: "项目",
  plugin: "插件",
  synced: "claude.ai 同步",
  system: "自带",
  shared: "共享目录",
};

export type RuntimeFilter = SkillRuntime | "all";

/** 各 runtime 有几个技能（筛选按钮上的数字）；没有技能的 runtime 不出按钮 */
export function runtimeCounts(skills: LibrarySkill[]): Array<{ id: RuntimeFilter; n: number }> {
  const out: Array<{ id: RuntimeFilter; n: number }> = [{ id: "all", n: skills.length }];
  for (const r of ["claude-code", "codex", "pi"] as const) {
    const n = skills.filter((s) => s.runtime === r).length;
    if (n) out.push({ id: r, n });
  }
  return out;
}

const SCOPE_ORDER: SkillScope[] = ["personal", "project", "shared", "plugin", "system", "synced"];

/** 筛选 + 排序：生效的在前（被覆盖的沉底），再按作用域、名字；搜索看名字和说明 */
export function visibleSkills(skills: LibrarySkill[], runtime: RuntimeFilter, query: string): LibrarySkill[] {
  const q = query.trim().toLowerCase();
  return skills
    .filter((s) => runtime === "all" || s.runtime === runtime)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!!a.shadowedBy) - Number(!!b.shadowedBy) ||
        SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) ||
        a.name.localeCompare(b.name),
    );
}

/** 路径里的家目录缩成 ~（手机上窄，路径越短越好认） */
export function shortPath(p: string, home: string | null): string {
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
}

/** 家目录：个人技能根一定是 <home>/.claude/skills，从它反推（接口不单独报 home） */
export function homeOf(roots: SkillRoot[]): string | null {
  const r = roots.find((x) => x.runtime === "claude-code" && x.scope === "personal");
  return r ? r.dir.replace(/\/\.claude\/skills$/, "") : null;
}

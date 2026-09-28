/**
 * 按会话启停技能（components/agent-skills-section.tsx）与技能库页「在哪些会话里关着」的纯逻辑。
 * 数据：GET/POST /api/v1/agents/:name/skill-settings、GET /skills/library 的 overrides（bridge 的 src/lib/agent-skills.ts）；
 * 接口与「待重启」小 store 在 agent-skills-api.ts。纯函数，tests/web-agent-skills.test.ts。
 */
import type { SkillScope } from "./skills-library-logic";

export type SkillState = "on" | "off" | "name-only" | "user-invocable-only";
export const SKILL_STATES: SkillState[] = ["on", "name-only", "user-invocable-only", "off"];
/** 四档的短标签（分段控件）与说明（title） */
export const STATE_LABEL: Record<SkillState, string> = { on: "开", "name-only": "只名字", "user-invocable-only": "仅手动", off: "关" };
export const STATE_HINT: Record<SkillState, string> = {
  on: "模型和 / 菜单都能用",
  "name-only": "只给模型看名字，不带说明，省上下文",
  "user-invocable-only": "模型看不到，只能在 / 菜单里手动调",
  off: "模型和 / 菜单都看不到",
};

export interface AgentSkillRow {
  name: string;
  description: string;
  scope: SkillScope | "missing";
  dir: string | null;
  state: SkillState;
  userInvocable: boolean;
  modelInvocable: boolean;
}
export interface AgentSkillView {
  runtime: "claude-code" | "pi" | "codex";
  supported: boolean;
  reason?: "inherit" | "codex";
  rows: AgentSkillRow[];
}

/** 关着的在前（最常见的操作是找回来），再按名字；搜索看名字和说明 */
export function sortRows(rows: AgentSkillRow[], query: string): AgentSkillRow[] {
  const q = query.trim().toLowerCase();
  return rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    .sort((a, b) => Number(a.state === "on") - Number(b.state === "on") || a.name.localeCompare(b.name));
}

/** 技能库页：{ agent: { skill: 档位 } } → { skill: [agent…] }（只算不是「开」的） */
export function offAgentsBySkill(overrides: Record<string, Record<string, string>> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [agent, table] of Object.entries(overrides ?? {})) {
    for (const [skill, state] of Object.entries(table)) if (state !== "on") (out[skill] ??= []).push(agent);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

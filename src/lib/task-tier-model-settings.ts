/**
 * 模型档位表里「类型 × 角色」那一层（TIER3）的存储形状与约束：role-model-settings.json 可选的 tiers 字段。旧表没有它照样有效，读取不改写。
 * 一格不写 = 缺省（用 task-tier-models.ts 的产品默认）；写 "inherit" = 显式继承角色格；codex 另有 "down1" = 已知原档降一档。
 * security 约束在这里统一判（保存、读盘、API 都经 roleModelsProblem → tierTableProblem）：Claude 必须落到 Opus 档（显式继承时看角色格），
 * Codex 只能沿用原档（不写或 inherit）。写入仍只经 role-model-settings-save.ts（锁 + CAS + 原子写），合并规则在 mergeTierPatch。
 * 只 import type 角色表模块：role-model-settings.ts 反过来调这里的校验，避免循环初始化。tests/task-tier-models.test.ts。
 */
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { isCodexModel } from "./lend-config.js";
import type { CardRole, RoleModelCell } from "./role-model-settings.js";
import { TASK_TIERS, isTaskTier, type TaskTier } from "./task-tier-spec.js";

export type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];
type TierClaudeCell = string;
type TierCodexCell = CodexEffort | null | "inherit" | "down1";
/** 缺字段 = 缺省；claude 是完整模型 id 或 "inherit" */
interface TierCell { claude?: TierClaudeCell; codex?: TierCodexCell }
export type TierTable = Partial<Record<TaskTier, Partial<Record<CardRole, TierCell>>>>;

export const isClaudeModelId = (v: unknown): v is string => typeof v === "string" && /^claude-[a-z0-9][a-z0-9.-]*$/.test(v) && isCodexModel(v);
const isEffort = (v: unknown): v is CodexEffort => CODEX_EFFORT_LEVELS.includes(v as CodexEffort);
/** security 的 Claude 下限：Opus 家的任一型号；别的（含不认识的型号）都核实不了，不算达标 */
export const isOpusGrade = (model: unknown): boolean => typeof model === "string" && /^claude-opus-[a-z0-9.-]+$/.test(model);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** security 一格的下限问题；roleCell = 显式继承时落到的那一格 */
function securityCellProblem(role: CardRole, cell: TierCell, roleCell: RoleModelCell | undefined): string | null {
  if (cell.claude !== undefined) {
    const model = cell.claude === "inherit" ? roleCell?.claude : cell.claude;
    if (!isOpusGrade(model)) return `security 的 ${role} 不得低于 Opus（${cell.claude === "inherit" ? `继承的角色格是 ${model ?? "空"}` : `写的是 ${model}`}）`;
  }
  if (cell.codex !== undefined && cell.codex !== "inherit") return `security 的 ${role} Codex 只能沿用原档（不写或 inherit），不能写 ${String(cell.codex)}`;
  return null;
}

function cellProblem(v: unknown, where: string): string | null {
  if (!isObj(v)) return `${where} 要是对象`;
  const x = Object.keys(v).find((k) => k !== "claude" && k !== "codex");
  if (x !== undefined) return `${where} 不认识的字段 ${x}`;
  if (v.claude !== undefined && v.claude !== "inherit" && !isClaudeModelId(v.claude)) return `${where}.claude 要是完整的 Claude 模型 id 或 inherit`;
  if (v.codex !== undefined && v.codex !== null && v.codex !== "inherit" && v.codex !== "down1" && !isEffort(v.codex)) {
    return `${where}.codex 要是 null、inherit、down1 或 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  }
  return null;
}

/** 整个 tiers 字段：不认识的类型 / 角色 / 字段算坏；security 每格按角色格核下限 */
export function tierTableProblem(v: unknown, roles: readonly CardRole[], roleCells: Partial<Record<CardRole, RoleModelCell>>): string | null {
  if (!isObj(v)) return "tiers 要是对象";
  for (const [tier, row] of Object.entries(v)) {
    if (!isTaskTier(tier)) return `tiers 不认识的类型 ${tier}（只认 ${TASK_TIERS.join(" / ")}）`;
    if (!isObj(row)) return `tiers.${tier} 要是对象`;
    for (const [role, cell] of Object.entries(row)) {
      if (!roles.includes(role as CardRole)) return `tiers.${tier} 不认识的角色 ${role}`;
      const p = cellProblem(cell, `tiers.${tier}.${role}`) ?? (tier === "security" ? securityCellProblem(role as CardRole, cell as TierCell, roleCells[role as CardRole]) : null);
      if (p) return p;
    }
  }
  return null;
}

/** 补丁里类型那一格：claude / codex 写 "default" = 删掉这一格回到缺省 */
export interface TierPatchFields { tier: TaskTier; claude?: TierClaudeCell | "default"; codex?: TierCodexCell | "default" }

export function parseTierPatchFields(b: Record<string, unknown>): TierPatchFields | string {
  if (!isTaskTier(b.tier)) return `tier 只认 ${TASK_TIERS.join(" / ")}`;
  if (b.claude === undefined && b.codex === undefined) return "没有要改的：给 claude 或 codex";
  if (b.claude !== undefined && b.claude !== "default" && b.claude !== "inherit" && !isClaudeModelId(b.claude)) return "claude 要是完整的 Claude 模型 id、inherit 或 default";
  if (b.codex !== undefined && b.codex !== null && !["default", "inherit", "down1"].includes(b.codex as string) && !isEffort(b.codex)) {
    return `codex 只认 null、inherit、down1、default 或 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  }
  return { tier: b.tier, ...(b.claude !== undefined ? { claude: b.claude as string } : {}), ...(b.codex !== undefined ? { codex: b.codex as TierCodexCell | "default" } : {}) };
}

/** 新表的 tiers（不改入参）；空格 / 空类型删掉，免得「写过又删」和「从没写过」读出来不一样 */
export function mergeTierPatch(cur: TierTable | undefined, role: CardRole, p: TierPatchFields): TierTable {
  const row = { ...(cur?.[p.tier] ?? {}) };
  const cell: TierCell = { ...(row[role] ?? {}) };
  for (const f of ["claude", "codex"] as const) {
    const v = p[f];
    if (v === "default") delete cell[f];
    else if (v !== undefined) (cell as Record<string, unknown>)[f] = v;
  }
  if (Object.keys(cell).length) row[role] = cell; else delete row[role];
  const out: TierTable = { ...(cur ?? {}), [p.tier]: row };
  if (!Object.keys(row).length) delete out[p.tier];
  return out;
}

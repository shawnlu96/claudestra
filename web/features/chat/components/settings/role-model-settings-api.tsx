"use client";
/**
 * 模型档位表的接口包装与纯函数（bridge local-api/role-model-settings.ts，GET / PUT /settings/role-models），一律经 lib/api/client。
 * 403 / 404 = 这台设备不给看（guest、部分 scope）或 bridge 太旧：返回 null，设置块整块不渲染。保存失败抛 ApiError，message 是 bridge 的原因；
 * 409 时 body.current 是 bridge 带回的现表，界面按它刷新。
 * TIER3g：类型 × 角色那一层（tiers）与 bridge 算好的 effective / projects / templates 只做展示，继承与档位解析不在前端复制。
 */
import { api, ApiError } from "@/lib/api/client";
import { useLang } from "@/lib/i18n";

export interface RoleModelRow { role: string; claude: string; codex: string | null }
/** bridge 解析好的一格：值 + 来源（task-tier-models.ts resolveTierModel / role-model-settings.ts roleModelOf 原样） */
export interface EffectiveCell { value: string | null; source: string; note?: string }
export interface EffectiveRow { role: string; claude: EffectiveCell; codex: EffectiveCell }
/** 类型格的存值：缺字段 = 缺省（产品默认）；"inherit" = 显式继承角色格；codex 另有 "down1" */
export interface TierCell { claude?: string; codex?: string | null }
export type ProjectTierView = { mode: "on" | "observe" | "off"; diagnostic?: undefined } | { mode?: undefined; diagnostic: string };
export interface RoleModelView {
  ok: true;
  config: { status: "missing" | "ok" | "invalid" | "unreadable"; error: "config_invalid" | "config_unreadable" | null };
  rev: number;
  families: string[];
  roles: RoleModelRow[];
  codexEfforts: string[];
  warning?: "replaced_invalid";
  /** 以下 TIER3 / TIER3f 字段旧 bridge 没有：缺了就只显示角色格，不显示类型选择 */
  tiers?: Record<string, Record<string, TierCell>>;
  taskTiers?: string[];
  effective?: Record<string, EffectiveRow[]>;
  projects?: Record<string, ProjectTierView>;
  templates?: Record<string, boolean>;
}
export interface RoleModelPatch { rev: number; role: string; tier?: string; claude?: string; codex?: string | null }

/** 类型选择里「角色格」那一项（= 未声明类型的卡，effective.undeclared） */
export const ROLE_LAYER = "";
/** 类型格草稿里「缺省」的取值，PUT 时原样发 "default"（bridge 删掉这一格） */
export const TIER_DEFAULT = "default";

const PATH = "/settings/role-models";

export async function fetchRoleModels(): Promise<RoleModelView | null> {
  try {
    return await api<RoleModelView>(PATH, { timeoutMs: 8000 });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

export function putRoleModels(patch: RoleModelPatch): Promise<RoleModelView> {
  return api<RoleModelView>(PATH, { method: "PUT", json: patch, timeoutMs: 8000 });
}

/** 409 回包里 bridge 带回的现表；别的错误 = null */
export function conflictView(e: unknown): RoleModelView | null {
  const cur = e instanceof ApiError && e.status === 409 ? e.body.current : null;
  return cur && typeof cur === "object" ? (cur as RoleModelView) : null;
}

/** 这一层这一行的存值，摊成草稿形状（类型格缺字段 = TIER_DEFAULT） */
export function baseRowOf(v: RoleModelView, tier: string, role: string): RoleModelRow {
  if (tier === ROLE_LAYER) return v.roles.find((r) => r.role === role) ?? { role, claude: "", codex: null };
  const cell = v.tiers?.[tier]?.[role] ?? {};
  return { role, claude: cell.claude ?? TIER_DEFAULT, codex: cell.codex === undefined ? TIER_DEFAULT : cell.codex };
}

/** 这一层的有效值（bridge 算好的）；旧 bridge 没给 = undefined */
export function effectiveOf(v: RoleModelView, tier: string, role: string): EffectiveRow | undefined {
  return v.effective?.[tier === ROLE_LAYER ? "undeclared" : tier]?.find((r) => r.role === role);
}

/** 一行的草稿 → 只带改了的格的补丁；没改 = null。tier 非空 = 改类型格 */
export function patchOf(rev: number, row: RoleModelRow, draft: RoleModelRow, tier: string = ROLE_LAYER): RoleModelPatch | null {
  const p: RoleModelPatch = { rev, role: row.role, ...(tier !== ROLE_LAYER ? { tier } : {}) };
  if (draft.claude !== row.claude) p.claude = draft.claude;
  if (draft.codex !== row.codex) p.codex = draft.codex;
  return "claude" in p || "codex" in p ? p : null;
}

/** 保存失败给人看的原因：403 = 设备权限不够；400 带 bridge 的校验原文（以服务端为准） */
export function saveErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return "这台设备没有改档位表的权限（要 owner 的全权设备）";
    const reason = typeof e.body.reason === "string" ? e.body.reason : null;
    return reason && reason !== e.message ? `${e.message}（${reason}）` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export const SOURCE_LABELS: Record<string, string> = {
  "tier-settings": "类型格设置", "tier-default": "类型默认", "role-settings": "继承角色格", "role-default": "继承角色默认",
  settings: "角色格设置", default: "默认表", error: "档位表坏了，按默认表", override: "覆盖", explicit: "显式参数",
};
export const PROJECT_MODE_LABELS: Record<string, string> = { on: "启用", observe: "只观察", off: "关闭" };

export const ROLE_LABELS: Record<string, string> = { author: "作者", reviewer: "审查", "adversarial-reviewer": "对抗式审查", "pm-reviewer": "PM 审查" };

export function configErrorText(c: RoleModelView["config"]): string | null {
  if (c.error === "config_unreadable") return "档位表文件读不了，正按默认表执行；修好文件权限后再保存";
  if (c.error === "config_invalid") return "档位表文件内容不合法，正按默认表执行；保存一次即修复";
  return null;
}

const WORDS: Record<string, string> = {
  "角色模型档位": "Role model tiers", "角色": "Role", "Claude 模型": "Claude model", "Codex 推理档": "Codex reasoning", "保存": "Save", "已保存": "Saved",
  "保存失败": "Save failed", "加载失败": "Failed to load", "照 Codex 配置": "Codex config", "作者": "Author", "审查": "Reviewer", "对抗式审查": "Adversarial reviewer",
  "PM 审查": "PM reviewer",
  "本机建卡时各角色用的模型 / 推理档。是否真正用于启动由恢复策略 roleModel 决定：缺省只观察（只在卡上记「本会用」，启动不变）。":
    "Model / reasoning per card role. Whether launches use it is decided by the roleModel recovery policy: observe by default (recorded on the card, launch unchanged).",
  "档位表文件读不了，正按默认表执行；修好文件权限后再保存": "The tier file is unreadable; defaults apply. Fix its permissions, then save",
  "档位表文件内容不合法，正按默认表执行；保存一次即修复": "The tier file is invalid; defaults apply. Save once to repair",
  "原档位表文件损坏，已另存备份后按这次保存的内容重写": "The corrupt tier file was backed up and rewritten with this save",
  "模型档位表正被别的请求修改，稍后再试": "The tier table is being changed by another request; try again",
  "这张表刚被别处改过，已刷新为最新值，请确认后再改": "The table was just changed elsewhere and has been refreshed; review and try again",
  "读不了模型档位表文件，没有保存（详情见本机日志）": "Could not read the tier file; nothing saved (see local log)",
  "保存模型档位表失败，没有生效（详情见本机日志）": "Saving the tier table failed and did not take effect (see local log)",
  "这次修改不符合档位约束，没有保存": "This change violates the tier constraints; nothing saved",
  "这台设备没有改档位表的权限（要 owner 的全权设备）": "This device may not change the tier table (needs the owner's full-access device)",
  "任务类型": "Task type", "正在保存，存完再换类型": "Saving — switch type when done", "角色格（未声明类型）": "Role cells (no task type)", "模板未注册": "no template",
  "缺省（类型默认）": "Default (task type)", "继承角色格": "Inherit role cell", "已知原档降一档": "One below base",
  "有效": "Effective", "类型格设置": "task type setting", "类型默认": "task type default", "继承角色默认": "inherited role default",
  "角色格设置": "role setting", "默认表": "default table", "档位表坏了，按默认表": "tier file broken, defaults", "覆盖": "override", "显式参数": "explicit",
  "项目档位": "Project mode", "启用": "on", "只观察": "observe", "关闭": "off", "读不到": "unreadable", "还没有项目": "No projects yet",
  "security 已锁定：Claude 必须是 Opus 档（继承时看角色格），Codex 只能沿用原档；不合规的保存由服务端拒绝":
    "security is locked: Claude must be Opus-grade (inherited cells checked too) and Codex keeps its base effort; the server rejects anything else",
  "这个类型还没有注册流程模板：可以保存，但这类卡现在开不了": "This task type has no registered template: you can save, but such cards cannot start yet",
};

export function useRoleModelT() {
  const lang = useLang();
  return (text: string) => (lang === "zh" ? text : WORDS[text] ?? text);
}

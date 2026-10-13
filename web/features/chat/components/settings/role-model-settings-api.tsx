"use client";
/**
 * 模型档位表的接口包装与纯函数（bridge local-api/role-model-settings.ts，GET / PUT /settings/role-models），一律经 lib/api/client。
 * 403 / 404 = 这台设备不给看（guest、部分 scope）或 bridge 太旧：返回 null，设置块整块不渲染。保存失败抛 ApiError，message 是 bridge 的原因；
 * 409 时 body.current 是 bridge 带回的现表，界面按它刷新。
 */
import { api, ApiError } from "@/lib/api/client";
import { useLang } from "@/lib/i18n";

export interface RoleModelRow { role: string; claude: string; codex: string | null }
export interface RoleModelView {
  ok: true;
  config: { status: "missing" | "ok" | "invalid" | "unreadable"; error: "config_invalid" | "config_unreadable" | null };
  rev: number;
  families: string[];
  roles: RoleModelRow[];
  codexEfforts: string[];
  warning?: "replaced_invalid";
}
export interface RoleModelPatch { rev: number; role: string; claude?: string; codex?: string | null }

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

/** 一行的草稿 → 只带改了的格的补丁；没改 = null */
export function patchOf(rev: number, row: RoleModelRow, draft: RoleModelRow): RoleModelPatch | null {
  const p: RoleModelPatch = { rev, role: row.role };
  if (draft.claude !== row.claude) p.claude = draft.claude;
  if (draft.codex !== row.codex) p.codex = draft.codex;
  return "claude" in p || "codex" in p ? p : null;
}

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
};

export function useRoleModelT() {
  const lang = useLang();
  return (text: string) => (lang === "zh" ? text : WORDS[text] ?? text);
}

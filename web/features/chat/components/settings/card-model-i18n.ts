"use client";
import { useLang } from "@/lib/i18n";

const WORDS: Record<string, string> = {
  "开关对应项目": "Switches for project",
  "现存设置": "Stored setting", "不符合安全下限": "Security floor not met",
  "卡片模型": "Card models", "职责": "Role", "作者": "Author", "审查": "Reviewer", "对抗审查": "Adversarial reviewer", "PM 审查": "PM reviewer",
  "安全": "Security", "代码": "Code", "界面": "UI", "文档": "Docs", "未声明": "Undeclared",
  "任务类型": "Task types", "角色格": "Undeclared roles", "生效": "Active", "不生效": "Inactive",
  "只记录，不改启动参数": "Record only; launch arguments unchanged",
  "每格显示服务端解析值；观察或关闭时不会用于启动。": "Each cell shows the server-resolved value. Observe and off modes do not apply it to launches.",
  "本页设置": "Page setting", "产品默认": "Product default", "跟随『未声明』那一格": "Follow the undeclared cell",
  "跟随全局默认": "Follow global default", "跟随": "Follow", "降一档": "One level lower", "恢复产品默认": "Use product default",
  "Claude 模型": "Claude model", "Claude 推理档": "Claude reasoning", "Codex 模型": "Codex model", "Codex 推理档": "Codex reasoning",
  "保存": "Save", "已保存": "Saved", "加载中": "Loading", "加载失败": "Failed to load", "保存失败": "Save failed",
  "别处先改了，已刷新，请重新检查": "Changed elsewhere first. Refreshed; please review again",
  "会自动派子 agent，卡片会话里不建议使用": "Automatically spawns subagents; not recommended in card sessions",
  "原档不可核实，不猜降档": "Original level cannot be verified; no downgrade is guessed",
  "安全下限：Claude 至少 Opus；Codex 只能跟随原档。": "Security floor: Claude requires Opus or higher; Codex must follow the original level.",
  "档位表文件读不了，正按默认表执行；修好文件权限后再保存": "The file is unreadable; defaults apply. Fix permissions before saving",
  "档位表文件内容不合法，正按默认表执行；保存一次即修复": "The file is invalid; defaults apply. Save once to repair",
  "原档位表文件损坏，已另存备份后按这次保存的内容重写": "The invalid file was backed up and repaired",
  "模型档位表正被别的请求修改，稍后再试": "Another request is editing the table; try again shortly",
  "读不了模型档位表文件，没有保存（详情见本机日志）": "Cannot read the settings file; nothing saved (see local log)",
  "这次修改不符合档位约束，没有保存": "The changes violate the model constraints; nothing saved",
  "保存模型档位表失败，没有生效（详情见本机日志）": "Could not save the settings; nothing changed (see local log)",
  "请求失败，请重试；安全类型须满足表中下限": "Request failed; retry and check the security floor shown in the table",
};
export const CARD_ROLE_LABELS: Record<string, string> = { author: "作者", reviewer: "审查", "adversarial-reviewer": "对抗审查", "pm-reviewer": "PM 审查" };
export const CARD_TIER_LABELS: Record<string, string> = { security: "安全", code: "代码", ui: "界面", docs: "文档", undeclared: "未声明" };
export function useCardModelT() {
  const lang = useLang();
  return (text: string) => lang === "zh" ? text : WORDS[text] ?? (/\p{Script=Han}/u.test(text) ? WORDS["请求失败，请重试；安全类型须满足表中下限"] : text);
}

/** API 校验原文定位到格子；角色 id 只用于定位，不出现在可见文案里。 */
export function cardModelError(raw: string, t: (s: string) => string): string {
  const role = Object.keys(CARD_ROLE_LABELS).sort((a, b) => b.length - a.length).find((r) => raw.includes(r));
  const tier = Object.keys(CARD_TIER_LABELS).find((r) => raw.includes(r));
  if (raw.includes("security") && role) return `${t(CARD_TIER_LABELS.security)} · ${t(CARD_ROLE_LABELS[role])} · ${raw.includes("Codex") ? "Codex" : "Claude"}: ${t("不符合安全下限")}`;
  let message = raw;
  if (role) message = message.replaceAll(role, t(CARD_ROLE_LABELS[role]));
  if (tier) message = message.replaceAll(tier, t(CARD_TIER_LABELS[tier]));
  return t(message);
}

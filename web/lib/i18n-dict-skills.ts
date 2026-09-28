/**
 * i18n 字典分册：设置 · 技能库、会话详情里的按会话启停技能（settings/skills-section.tsx、components/agent-skills-section.tsx）。
 * 规则同 lib/i18n-dict.ts；主字典到了数据文件的行数上限，新功能的整块词条放分册再并进 DICT。
 */
export const SKILLS_DICT: Record<string, string> = {
  "技能库": "Skills",
  "这台电脑上的技能": "Skills on this computer",
  "各 runtime 能用哪些技能、从哪来、同名时谁生效。按会话开关在会话详情里；安装后面做。":
    "Which skills each runtime can use, where they come from, and which one wins on a name clash. Turn them on or off per session in the session details; installing comes later.",
  "全部": "All",
  "搜索技能": "Search skills",
  "没有匹配的技能": "No matching skills",
  "个人": "personal",
  "claude.ai 同步": "synced from claude.ai",
  "自带": "built-in",
  "共享目录": "shared folder",
  "被{scope}的同名技能盖过": "overridden by a {scope} skill of the same name",
  "同名还有 {n} 处": "{n} more with this name",
  "不在 / 菜单": "hidden from / menu",
  "只能手动调用": "manual only",
  "找了哪些目录（{n} 个，{m} 个存在）": "Folders searched ({n}, {m} exist)",
  "不存在": "missing",
  // ── 按会话启停 ──
  "这个会话的技能": "Skills in this session",
  "{n} 个，{m} 个没开": "{n} skills, {m} not on",
  "只影响这个会话，改完重启后生效。": "Affects this session only; changes apply after a restart.",
  "只显示开关": "Just on / off",
  "显示全部档位": "Show all levels",
  "大总管的技能被关可能影响它的日常流程，比如 save-compact。": "Turning off Master's skills may break its routine, e.g. save-compact.",
  "Codex 暂不支持按会话启停技能（它的技能目录是全局的）。": "Codex can't turn skills on or off per session yet (its skill folder is global).",
  "这个 Pi 会话是「继承全局」档：全部技能都启用。切到最小集（minimal）才能逐个管。":
    "This Pi session inherits the global setup, so every skill is on. Switch it to minimal to manage them one by one.",
  "没有可管的技能": "No skills to manage",
  "重启大总管后生效（设置 · 会话与自动化里的「重启全部会话」会连大总管一起重启）。":
    "Applies after Master restarts (Settings · Sessions & automation → Restart all sessions includes Master).",
  "改动重启后生效。": "Changes apply after a restart.",
  "已不存在": "gone",
  "开": "On",
  "只名字": "Name only",
  "仅手动": "Manual only",
  "关": "Off",
  "模型和 / 菜单都能用": "Available to the model and in the / menu",
  "只给模型看名字，不带说明，省上下文": "The model sees only the name, not the description, to save context",
  "模型看不到，只能在 / 菜单里手动调": "Hidden from the model; only callable from the / menu",
  "模型和 / 菜单都看不到": "Hidden from both the model and the / menu",
  "大总管的技能": "Master's skills",
  "在 {n} 个会话里没开": "Not on in {n} session|Not on in {n} sessions",
};

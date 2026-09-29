/**
 * 设置类端点（§13.2 的 T4 本地 API + bridge 既有配置端点）。BFF 时代每个路由自带一层 {data} 包装 / 字段改名，
 * 这里把形状**原样**还给组件（它们的 props 不变），只是数据源换成 bridge。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api } from "./client";

// ── 全局设置（语言 / 语音识别 key / 推送不带正文）：GET 只回是否已配 + 尾四位，完整 key 永不回传 ──
export interface GlobalSettings {
  groqApiKeySet: boolean;
  groqApiKeyHint: string;
  lang?: "zh" | "en";
  /** 这台电脑的推送只写「有新消息」（老 bridge 没这个字段 → false） */
  pushNoContent: boolean;
}
const shapeSettings = (j: { lang?: unknown; groqApiKeyHint?: unknown; pushNoContent?: unknown }): GlobalSettings => {
  const hint = typeof j.groqApiKeyHint === "string" ? j.groqApiKeyHint : "";
  return { groqApiKeySet: !!hint, groqApiKeyHint: hint, pushNoContent: j.pushNoContent === true, ...(j.lang === "en" || j.lang === "zh" ? { lang: j.lang } : {}) };
};
export function getSettings(): Promise<GlobalSettings> {
  return api("/settings", { timeoutMs: 8000 }).then(shapeSettings);
}
/** 空串 groqApiKey = 清除 */
export function putSettings(patch: { lang?: "zh" | "en"; groqApiKey?: string; pushNoContent?: boolean }): Promise<GlobalSettings> {
  return api("/settings", { method: "PUT", json: patch, timeoutMs: 8000 }).then(shapeSettings);
}

// ── per-agent 设置（clear 后自动发送的开机指令）──
export function getAgentSettings(agent: string): Promise<{ initMessage: string }> {
  return api<{ initMessage?: string | null }>(`/agents/${encodeURIComponent(apiAgentName(agent))}/settings`, { timeoutMs: 8000 }).then((j) => ({ initMessage: j.initMessage ?? "" }));
}
export function putAgentSettings(agent: string, initMessage: string): Promise<void> {
  return api(`/agents/${encodeURIComponent(apiAgentName(agent))}/settings`, { method: "PUT", json: { initMessage }, timeoutMs: 8000 }).then(() => undefined);
}

// ── 个人资料：bridge 形状 {user:{nickname,avatar}, claude:{…}} ↔ 前端平铺 ──
export interface Profile {
  nickname: string;
  avatar: string;
  claudeNickname: string;
  claudeAvatar: string;
}
interface ProfileWire {
  user?: { nickname?: string; avatar?: string };
  claude?: { nickname?: string; avatar?: string };
}
export function getProfile(): Promise<Profile> {
  return api<ProfileWire>("/profile", { timeoutMs: 8000 }).then((j) => ({
    nickname: j.user?.nickname ?? "",
    avatar: j.user?.avatar ?? "",
    claudeNickname: j.claude?.nickname ?? "",
    claudeAvatar: j.claude?.avatar ?? "",
  }));
}
export function putProfile(p: Profile): Promise<void> {
  const body: ProfileWire = { user: { nickname: p.nickname, avatar: p.avatar }, claude: { nickname: p.claudeNickname, avatar: p.claudeAvatar } };
  return api("/profile", { method: "PUT", json: body, timeoutMs: 15_000 }).then(() => undefined);
}

// ── Skill 快捷入口偏好：bridge 给 {prefs:[{name,pinned,usedCount}]}，面板要 {pins[], counts{}} ──
export interface SkillPrefs {
  pins: string[];
  counts: Record<string, number>;
}
export function getSkillPrefs(): Promise<SkillPrefs> {
  return api<{ prefs?: { name: string; pinned: boolean; usedCount: number }[] }>("/skills/prefs", { timeoutMs: 8000 }).then((j) => {
    const prefs = j.prefs ?? [];
    const counts: Record<string, number> = {};
    for (const p of prefs) if (p.usedCount > 0) counts[p.name] = p.usedCount;
    return { pins: prefs.filter((p) => p.pinned).map((p) => p.name), counts };
  });
}
export function pinSkill(name: string, pinned: boolean): Promise<void> {
  return api(`/skills/prefs/${encodeURIComponent(name)}`, { method: "PUT", json: { pinned }, timeoutMs: 8000 }).then(() => undefined);
}
export function skillUsed(name: string): Promise<void> {
  return api(`/skills/prefs/${encodeURIComponent(name)}/used`, { method: "POST", json: {}, timeoutMs: 8000 }).then(() => undefined);
}

// ── Claude 全局默认（模型 + effort，bridge 写 ~/.claude/settings.json）──
export type ClaudeDefaults = { model: string | null; effort: string | null };
export function getClaudeDefaults(): Promise<ClaudeDefaults> {
  return api<ClaudeDefaults>("/config/claude-defaults", { timeoutMs: 8000 }).then((r) => ({ model: r.model, effort: r.effort }));
}
export function putClaudeDefaults(patch: { model?: string; effort?: string }): Promise<ClaudeDefaults> {
  return api<ClaudeDefaults>("/config/claude-defaults", { method: "PUT", json: patch, timeoutMs: 8000 }).then((r) => ({ model: r.model, effort: r.effort }));
}

// ── 归档保留天数 ──
export function getArchiveRetention(): Promise<{ days?: number; defaultDays?: number }> {
  return api("/settings/archive-retention", { timeoutMs: 4000 });
}
export function putArchiveRetention(days: number): Promise<{ days?: number }> {
  return api("/settings/archive-retention", { method: "POST", json: { days }, timeoutMs: 8000 });
}

// ── autoCompact / 记忆卫生：bridge 回 {ok, …状态}，组件按 ok 判 ──
export function getAutoCompact<T>(): Promise<T> {
  return api<T>("/auto-compact", { timeoutMs: 8000 });
}
export function postAutoCompact<T>(patch: { window?: number; idleHours?: number; emergency?: boolean; inject?: boolean }): Promise<T> {
  return api<T>("/auto-compact", { method: "POST", json: patch, timeoutMs: 8000 });
}
export function getMemoryHygiene<T>(): Promise<T> {
  return api<T>("/memory-hygiene", { timeoutMs: 8000 });
}
export function postMemoryHygiene<T>(body: { enabled: boolean; freq: string }): Promise<T> {
  return api<T>("/memory-hygiene", { method: "POST", json: body, timeoutMs: 8000 });
}

// ── 更新通道 / 自动更新开关 / 能升到哪个版本 ──
export function getUpdateSettings<T>(): Promise<T> {
  return api<T>("/update/settings", { timeoutMs: 8000 });
}
export function postUpdateSettings<T>(patch: Record<string, unknown>): Promise<T> {
  return api<T>("/update/settings", { method: "POST", json: patch, timeoutMs: 8000 });
}
/** 要联网查 GitHub / origin，给足超时 */
export function updateCheck<T>(): Promise<T> {
  return api<T>("/update/check", { timeoutMs: 25_000 });
}

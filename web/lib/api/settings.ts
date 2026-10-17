/**
 * 设置类端点（§13.2 的 T4 本地 API + bridge 既有配置端点）。BFF 时代每个路由自带一层 {data} 包装 / 字段改名，
 * 这里把形状**原样**还给组件（它们的 props 不变），只是数据源换成 bridge。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api } from "./client";
import { talkEnabledOf } from "../talk-gate";
import { queueWhenBusy, readSteerQueueSettings, type SteerQueueMode } from "../steer-queue-capability";

// ── 全局设置（语言 / 语音识别 key / 推送不带正文）：GET 只回是否已配 + 尾四位，完整 key 永不回传 ──
export interface GlobalSettings {
  groqApiKeySet: boolean;
  groqApiKeyHint: string;
  jevApiKeySet: boolean;
  jevApiKeyHint: string;
  lang?: "zh" | "en";
  /** 这台电脑的推送只写「有新消息」（老 bridge 没这个字段 → false） */
  pushNoContent: boolean;
  /** Web Push / APNs 加推「待你处理」时不看卡没卡住工作（老 bridge 没这个字段 → false） */
  pushAllAsks: boolean;
  /** Chat（人与人，/talk）入口开没开（缺省关；老 bridge 没这个字段 → false） */
  talkEnabled: boolean;
  "steer.queueWhenBusy": boolean;
}
type RawSettings = { lang?: unknown; groqApiKeyHint?: unknown; jevApiKeyHint?: unknown; pushNoContent?: unknown; pushAllAsks?: unknown; talkEnabled?: unknown; "steer.queueWhenBusy"?: unknown };
const shapeSettings = (j: RawSettings, mode: SteerQueueMode = "on"): GlobalSettings => {
  const hint = typeof j.groqApiKeyHint === "string" ? j.groqApiKeyHint : "";
  const jev = typeof j.jevApiKeyHint === "string" ? j.jevApiKeyHint : "";
  return {
    "steer.queueWhenBusy": queueWhenBusy(j["steer.queueWhenBusy"], mode),
    groqApiKeySet: !!hint, groqApiKeyHint: hint, jevApiKeySet: !!jev, jevApiKeyHint: jev,
    pushNoContent: j.pushNoContent === true, pushAllAsks: j.pushAllAsks === true, talkEnabled: talkEnabledOf(j),
    ...(j.lang === "en" || j.lang === "zh" ? { lang: j.lang } : {}),
  };
};
export async function getSettings(): Promise<GlobalSettings> {
  const { raw, mode } = await readSteerQueueSettings();
  return shapeSettings(raw, mode);
}
/** 空串 groqApiKey / jevApiKey = 清除 */
type SettingsPatch = { lang?: "zh" | "en"; groqApiKey?: string; jevApiKey?: string; pushNoContent?: boolean; pushAllAsks?: boolean; talkEnabled?: boolean; "steer.queueWhenBusy"?: boolean };
export async function putSettings(patch: SettingsPatch): Promise<GlobalSettings> {
  const { raw, mode } = await readSteerQueueSettings(patch);
  return shapeSettings(raw, mode);
}
/** Jev 连通测试（bridge 用固定样例打一次 TypeSafe；失败时 bridge 回 {ok:false, code, error}，api() 会抛） */
export interface JevTestResult {
  model: string;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
  costUsd: number;
  plausible: boolean;
  answers: Record<string, { type: string; noul?: number; choice?: string; score?: number; confidence?: number }>;
}
export function jevTest(): Promise<JevTestResult> {
  return api<JevTestResult>("/jev/test", { method: "POST", json: {}, timeoutMs: 25_000 });
}
/** Jev 调用记录（bridge guard-log.jsonl，新的在前）：每条守门判定一行，error = Jev 失败、守门降级照投 */
export type JevVerdict = "pass" | "flag" | "block" | "error";
export interface JevLogEntry {
  id: string; ts: string; agent: string; verdict: JevVerdict;
  sender: { name: string; trust: string; kind: string };
  top?: { id: string; score: number | null }; ms?: number; tokens?: number; error?: string; preview?: string;
  action?: "released" | "dropped"; by?: string; actedAt?: string;
}
export interface JevLog { items: JevLogEntry[]; stats: Record<JevVerdict | "total", number> & { avgMs: number | null } }
export function jevLog(limit = 200): Promise<JevLog> {
  return api<JevLog>(`/jev/log?limit=${limit}`, { timeoutMs: 8000 });
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

// ── Codex 全局默认（模型 + 推理档，bridge 写 ~/.codex/config.toml 顶层两行）；null / "" = 清掉、回到 Codex 自己的默认 ──
export type CodexCatalogModel = { id: string; name: string; efforts: string[]; defaultEffort: string | null };
export interface CodexDefaults {
  model: string | null;
  effort: string | null;
  /** `codex debug models` 的目录；拉不到时为空、catalogOk=false（此时 bridge 不让改模型） */
  models: CodexCatalogModel[];
  catalogOk: boolean;
  /** 两项都没写时 Codex 实际用的 */
  codexDefault: { model: string | null; effort: string | null };
}
// 首次要跑一次 `codex debug models`（bridge 缓存 10 分钟），超时与 /codex-models 一致
export function getCodexDefaults(): Promise<CodexDefaults> {
  return api<CodexDefaults>("/config/codex-defaults", { timeoutMs: 20_000 });
}
export function putCodexDefaults(patch: { model?: string | null; effort?: string | null }): Promise<CodexDefaults & { effortCleared?: boolean }> {
  return api("/config/codex-defaults", { method: "PUT", json: patch, timeoutMs: 20_000 });
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

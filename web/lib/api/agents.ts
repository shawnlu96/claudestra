/**
 * agent 生命周期与运行时设置（此前 BFF 的 agents/* 路由）。响应形状保持组件既有约定：
 * 生命周期动作回 bridge 原样 {ok, …}；archive 回 {ok:true, data}；resume 回 bridge 原样（组件读 hint）。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api, ApiError } from "./client";

const enc = (agent: string) => encodeURIComponent(apiAgentName(agent));

export interface CreateAgentBody {
  name: string;
  dir: string;
  purpose?: string;
  model?: string;
  effort?: string;
  project?: string;
  runtime?: string;
  piBase?: string;
}

/** 新建 agent（bridge 内部 runManager create，会 spawn Claude Code，可能要 10-30s） */
export function createAgent(body: CreateAgentBody): Promise<{ ok?: boolean; agent?: string; error?: string }> {
  const opt = (k: keyof CreateAgentBody) => (typeof body[k] === "string" && body[k]!.trim() ? { [k]: body[k]!.trim() } : {});
  return api("/agents", {
    method: "POST",
    json: { name: body.name.trim(), dir: body.dir.trim(), purpose: body.purpose, ...opt("model"), ...opt("effort"), ...opt("project"), ...opt("runtime"), ...opt("piBase") },
    timeoutMs: 90_000,
  });
}

export type LifecycleAction = "kill" | "restart" | "remove" | "archive" | "pi-update" | "codex-update";
const LIFECYCLE_TIMEOUT: Record<LifecycleAction, number> = { kill: 60_000, restart: 90_000, remove: 60_000, archive: 30_000, "pi-update": 360_000, "codex-update": 360_000 };

export async function lifecycleAction(action: LifecycleAction, name: string): Promise<Record<string, unknown>> {
  const r = await api(`/agents/${encodeURIComponent(name.trim())}/${action}`, { method: "POST", json: {}, timeoutMs: LIFECYCLE_TIMEOUT[action] });
  return action === "archive" ? { ok: true, data: r } : r;
}

/** 收编一个会话成正式 agent；bridge 同步执行（起窗口 + 等就绪约 10-40s），失败原因在这一跳带回 */
/** confirmSubSession：用户已确认要单独收编一个子会话（bridge 对 Codex 子会话不带它回 409，见 src/bridge/subsession-guard.ts） */
export function resumeSession(body: { agent: string; sessionId: string; runtime?: string; cwd?: string; confirmSubSession?: boolean }): Promise<Record<string, unknown>> {
  return api("/agents/resume", { method: "POST", json: body, timeoutMs: 180_000 });
}

export interface RuntimeInfo {
  id: string;
  label: string;
  available: boolean;
}

/** 可建 agent 的运行时；桥接不可达 / 老 bridge → []（安全方向：不显示点了会报错的选项） */
export async function runtimes(): Promise<RuntimeInfo[]> {
  try {
    const j = await api<{ runtimes?: RuntimeInfo[] }>("/runtimes", { timeoutMs: 30_000 });
    return (j.runtimes ?? []).map((r) => ({ id: r.id, label: r.label, available: r.available === true }));
  } catch {
    return []; // 同上：拿不到就当只有默认运行时
  }
}

/** 这台机器有没有装 Pi；拿不到当没有（不显示一个点了会报错的选项） */
export function piAvailable(): Promise<boolean> {
  return api<{ piAvailable?: boolean }>("/capabilities", { timeoutMs: 4000 })
    .then((j) => j.piAvailable === true)
    .catch(() => false);
}

/** per-会话切模型 / effort；409 = 回合进行中（ApiError.status 原样给调用方提示） */
export function claudeSettings(agent: string, patch: { model?: string; effort?: string }): Promise<Record<string, unknown>> {
  return api(`/agents/${enc(agent)}/claude-settings`, { method: "POST", json: patch, timeoutMs: 20_000 });
}

export type RuntimeKind = "pi" | "codex";
const RUNTIME_LIST: Record<RuntimeKind, { path: string; timeoutMs: number }> = {
  pi: { path: "/pi-models", timeoutMs: 10_000 },
  codex: { path: "/codex-models", timeoutMs: 20_000 },
};

/** Pi / Codex 的模型清单（bridge 读 ~/.pi/agent/models.json / 跑 `codex debug models`） */
export function runtimeModels<T = Record<string, unknown>>(kind: RuntimeKind): Promise<T> {
  return api<T>(RUNTIME_LIST[kind].path, { timeoutMs: RUNTIME_LIST[kind].timeoutMs });
}

/** Pi / Codex 切模型 / 档位；Codex 要等一次重启，超时放宽到 60s */
export function runtimeSettings(kind: RuntimeKind, agent: string, patch: { model?: string; effort?: string }): Promise<Record<string, unknown>> {
  return api(`/agents/${enc(agent)}/${kind}-settings`, { method: "POST", json: patch, timeoutMs: kind === "codex" ? 60_000 : 20_000 });
}

/** Claude Code 的模型目录（三处模型下拉共用） */
export function claudeModels(): Promise<{ models?: Array<{ id: string; name: string; section: string }> }> {
  return api("/claude-models", { timeoutMs: 10_000 });
}

/** 组件里统一取错误文案（ApiError 带 bridge 的 error，其余按 message） */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  return (e as Error)?.message || fallback;
}

// ── Autopilot（bridge/local-api/mission.ts）：until 同命令行 HH:MM / +3h / ISO ──
export function startMission(agent: string, body: { goal: string; until: string; ledger?: string }): Promise<{ ok?: boolean; error?: string }> {
  return api(`/agents/${enc(agent)}/mission`, { method: "POST", json: body, timeoutMs: 10_000 });
}
export function stopMission(agent: string): Promise<{ ok?: boolean; error?: string }> {
  return api(`/agents/${enc(agent)}/mission`, { method: "DELETE", timeoutMs: 10_000 });
}

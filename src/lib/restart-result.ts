/**
 * v2.19.0 `manager.ts restart` 结果解读（纯逻辑，可单测）。
 *
 * 由来（peer 2026-08-13 P0）：launcher 的开机恢复波对每个 dead agent 调
 * `manager.ts restart <name>`，**返回值完全不检查**，失败也照打「restart 调用
 * 完成」。那次开机 9 个 restart 挂了 3 个——窗口建了、claude 从没启动、registry
 * 仍写 active，日志里一个字都没有，直到用户发消息没反应才发现。
 *
 * restart 一直都返回结构化结果，只是没人读：
 *   `{ ok: boolean, results: [{ name, ok, error? }], message }`
 * 这里把「怎么算失败、失败原因是什么」收敛成一个函数，让调用方无从忽略。
 */

import { statSync } from "fs";
import { isMasterAgent } from "./registry.js";
import { projectJsonlPath } from "./jsonl-cost.js";
import type { ReadyResult } from "./runtimes/types.js";

export interface RestartRunOutcome {
  /** 进程退出码是否为 0 */
  ok: boolean;
  /** stdout（期望是 restart 的 JSON） */
  out: string;
  /** stderr（JSON 解析不出时的兜底信息来源） */
  err?: string;
}

/**
 * 返回失败原因；成功返回 null。
 *
 * 判据优先级：
 * 1. stdout 是合法 JSON 且 `ok === false` → 汇总 results 里所有失败项的 error；
 * 2. stdout 不是 JSON（进程被超时杀掉 / 崩在输出之前）→ 退出码说了算，取
 *    stderr 末几行当原因（空 stderr 也要给出可读文本，不能返回空串——空串会被
 *    调用方当成成功）。
 */
export function restartFailureReason(r: RestartRunOutcome): string | null {
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.out || "");
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === "object") {
    if (parsed.ok !== false) return null;
    const perItem = Array.isArray(parsed.results)
      ? parsed.results
          .filter((x: any) => x && x.ok === false)
          .map((x: any) => (typeof x.error === "string" && x.error ? x.error : "未知错误"))
      : [];
    if (perItem.length) return perItem.join("; ");
    return typeof parsed.error === "string" && parsed.error ? parsed.error : "未知错误";
  }

  if (r.ok) return null; // 退出码 0 且没给 JSON —— 按成功处理，别造假失败
  const tail = (r.err || "").split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  return tail || "restart 进程非 0 退出且无输出";
}

/**
 * cmdRestart 逐 agent 循环里某个 agent 抛异常时，记进 results 的那一项。
 * 异常只算这个 agent 失败，循环继续——带上名字，launcher 的 restartFailedNames 才看得出是谁。
 */
export function restartExceptionResult(name: string, e: unknown): { name: string; ok: false; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  return { name, ok: false, error: `重启异常: ${msg || "未知错误"}` };
}

/** restart 结果里失败的 agent 名（「完成」消息只能列成功项，失败项要单独报）。 */
export function restartFailedNames(r: RestartRunOutcome): string[] {
  try {
    const parsed = JSON.parse(r.out || "");
    if (!Array.isArray(parsed?.results)) return [];
    return parsed.results
      .filter((x: any) => x && x.ok === false && typeof x.name === "string")
      .map((x: any) => x.name as string);
  } catch {
    return [];
  }
}

export type CanaryPlan =
  | { kind: "canary"; name: string }
  | { kind: "no-candidate" }
  | { kind: "list-failed"; reason: string };

/**
 * 升级重启波的金丝雀决策。「list 成功但没有可选的 agent」和「list 失败」必须分开：
 * 前者是真没 agent，跳过金丝雀无妨；后者是没验证过新版本能起就要进全量重启，
 * 以前两者都表现为 canary=undefined、静默跳过。
 */
export function canaryPlan(list: ListOutcome): CanaryPlan {
  if (!list.ok) return { kind: "list-failed", reason: list.reason };
  // 只挑「活着的 Claude Code agent 窗口」当金丝雀——重启波只在 CC 升级后触发，验的是新 CC 能不能起：
  // - 合成的 master 行（window 0 改名 master 后排在最前）：`restart master` 必然「不存在」→ 整波被误报中止；
  // - Pi / Codex：重启成功与新 CC 二进制无关，选中它等于没验就放行全量重启；
  // - dead 行（cmdList 只报 active / dead，没有 stopped）：它因自身原因起不来，会把整波误判成新版坏了。
  const c = list.agents.find(
    (a) => a.status === "active" && !isMasterAgent(a.name) && a.name.startsWith("agent-") && (a.runtime ?? "claude-code") === "claude-code",
  );
  return c ? { kind: "canary", name: c.name } : { kind: "no-candidate" };
}

export type ListOutcome =
  | { ok: true; agents: { name: string; status?: string; runtime?: string }[] }
  | { ok: false; reason: string };

/**
 * `manager.ts list` 结果解读。失败必须是失败——launcher 以前 `if (!list.ok) return` 不留
 * 一行日志、`JSON.parse(out || "{}").agents || []` 把坏输出读成「零个 agent」，于是开机
 * 恢复 / 巡检静默不干活，金丝雀因为「找不到 agent」被跳过、直接进全量重启波。
 */
export function parseManagerList(r: RestartRunOutcome): ListOutcome {
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.out || "");
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.ok === false) {
      return { ok: false, reason: typeof parsed.error === "string" && parsed.error ? parsed.error : "manager list 返回 ok:false" };
    }
    if (!Array.isArray(parsed.agents)) return { ok: false, reason: "manager list 输出缺少 agents 字段" };
    return { ok: true, agents: parsed.agents };
  }
  const tail = (r.err || "").split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  return { ok: false, reason: tail || (r.ok ? "manager list 输出不是 JSON" : "manager list 非 0 退出且无输出") };
}

/**
 * cron 临时 agent 收尾时 `manager.ts kill` 的结果解读：返回要告警的失败原因，无需告警返回 null。
 *
 * create 失败时窗口要么根本没建、要么已被 create 自己的 cleanup() kill-window + 删频道，
 * finally 里再 kill 必然得到「agent-cron-… 不存在」——那是「没有可清的东西」，不是清理失败。
 * 以前把它也当失败，每次 create 失败都多一条「清理失败，请手动 kill」的误导告警（手动 kill
 * 得到的也只会是同一句「不存在」）。其它失败（tmux 出错、进程没给结果）照常告警。
 */
export function tempAgentCleanupFailure(kill: { ok?: boolean; error?: unknown } | null | undefined): string | null {
  if (kill?.ok) return null;
  const error = typeof kill?.error === "string" && kill.error ? kill.error : "未知";
  return /^agent-\S+ 不存在$/.test(error) ? null : error;
}

/**
 * 就绪失败 → 给人看的原因（create / resume / restart 共用）。
 *
 * 以前三处调用方只读 `.ready`，一律报「启动超时」：Codex 刻意带回的对话框原文（blocked-dialog
 * 的 detail）、进程秒退（exited）、会话被 bg agent 占着（occupied）全被说成「超时」，
 * 容易被误读成机器慢 / 预算不够，而 create 的 cleanup 还会把屏幕证据一并销毁。
 */
export function readyFailureText(r: Extract<ReadyResult, { ready: false }>): string {
  const d = typeof r.detail === "string" ? r.detail.trim().slice(0, 300) : "";
  const tail = d ? `：${d}` : "";
  switch (r.reason) {
    case "exited":
      return `进程已退出${tail}`;
    case "blocked-dialog":
      return `被启动对话框挡住${tail}`;
    case "occupied":
      return `会话被占用（后台 agent 正占着它，可用 resume --fork 分叉接管）${tail}`;
    default:
      return `启动超时${tail}`;
  }
}

/**
 * `manager.ts model all` 的目标筛选：只有 modelEnforcement === "in-session" 的运行时（CC）
 * 才能被钉模型 / 在会话里注入 /model。
 *
 * 以前 `model all` 不看 runtime，把 Claude 别名写进所有 active agent：Codex 下次启动时
 * codexModel 遇到 claude/opus 直接抛错（整轮 restart-all 随之中断），`/model claude-…`
 * 还会被键进 Codex / Pi 的 TUI（它们 idleSource=hook，isAgentIdle 恒答空闲）。
 * 启动参数即权威的运行时（launch-flag）和认不出的运行时一律跳过，并说明原因。
 */
export function modelPinPlan(
  agents: Record<string, { status?: string; runtime?: string }>,
  enforcementOf: (runtime: string | undefined) => "in-session" | "launch-flag" | undefined,
): { pin: string[]; skipped: { name: string; reason: string }[] } {
  const pin: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const [name, info] of Object.entries(agents)) {
    if (info.status !== "active") continue;
    const e = enforcementOf(info.runtime);
    if (e === "in-session") pin.push(name);
    else skipped.push({ name, reason: modelPinRefusal(info.runtime, e) });
  }
  return { pin, skipped };
}

/** 单个 agent 不接受会话内钉模型时的说明（`model <agent> <model>` 直接拒绝时也用它）。 */
export function modelPinRefusal(runtime: string | undefined, enforcement: "in-session" | "launch-flag" | undefined): string {
  const rt = runtime || "claude-code";
  return enforcement === "launch-flag"
    ? `runtime "${rt}" 的模型由启动参数决定，不支持 model 命令钉模型（在 create 时用 --model 指定）`
    : `runtime "${rt}" 不能由 Claudestra 启动，不支持钉模型`;
}

/**
 * v2.21.1+ restart 超时报错附 session jsonl 体积（peer 建议）：--resume 整读大文件，346MB 级的
 * session 启动本身就要一两分钟，省得排查时再人肉 stat。不到 50MB 或文件不在原处 → 空串。
 */
export function bigSessionNote(cwd: string | undefined, sessionId: string): string {
  try {
    const sz = statSync(projectJsonlPath((cwd || "").replace(/^~/, process.env.HOME || "~"), sessionId)).size;
    if (sz > 50 * 1024 * 1024) {
      return `(session jsonl ${Math.round(sz / 1024 / 1024)}MB——resume 大会话本身可能就需 1-2 分钟,可考虑 clear/fork)`;
    }
  } catch { /* jsonl 不在原处,不加注 */ }
  return "";
}

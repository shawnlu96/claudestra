/**
 * `manager wake-cost --agent <名> [--today|--week|--since <ISO|ms>] [--json] [--write-weekly]`（PMCOST1）。
 *
 * 只读：读 registry 里该 agent 当前会话的记录文件，按叫醒切分计量（lib/wake-cost.ts），不改会话、不 ingest、不写 usage 库。
 * 只有显式 --write-weekly 才把无正文周汇总原子写到状态目录 wake-cost/<周起点>.json。说明见 docs/architecture/wake-cost.md。
 */
import { DEFAULT_RUNTIME } from "../lib/runtimes/index.js";
import { findSessionJsonlBySessionId, runtimeForSessionPath, sessionJsonlPath } from "../lib/session-source.js";
import { currentUsageWindow, type UsageWindowBounds } from "../lib/usage-window.js";
import { buildWakeReport, renderWakeTable, scanWakes, writeWeeklySummary, type WakeWindow } from "../lib/wake-cost.js";

export interface WakeCostArgs {
  agent: string | null;
  period: "today" | "week" | "since" | "all";
  since: number;
  json: boolean;
  writeWeekly: boolean;
}

export function parseWakeCostArgs(args: string[]): WakeCostArgs | { error: string } {
  const out: WakeCostArgs = { agent: null, period: "all", since: 0, json: false, writeWeekly: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agent" && args[i + 1]) out.agent = args[++i];
    else if (a === "--today") out.period = "today";
    else if (a === "--week") out.period = "week";
    else if (a === "--since" && args[i + 1]) {
      const v = args[++i];
      const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(ms)) return { error: `--since 认不出：${v}` };
      out.period = "since";
      out.since = ms;
    } else if (a === "--json") out.json = true;
    else if (a === "--write-weekly") out.writeWeekly = true;
    else if (!a.startsWith("--") && !out.agent) out.agent = a;
    else return { error: `未知参数：${a}` };
  }
  if (!out.agent) return { error: "用法：wake-cost --agent <名> [--today|--week|--since <ISO|ms>] [--json] [--write-weekly]" };
  if (out.writeWeekly && out.period === "all") out.period = "week";
  if (out.writeWeekly && out.period !== "week") return { error: "--write-weekly 只配周窗口（--week 或不写窗口）" };
  return out;
}

export function windowFor(a: WakeCostArgs, win: UsageWindowBounds): WakeWindow {
  if (a.period === "today") return { since: win.dayStart, source: "today" };
  if (a.period === "week") return { since: win.weekStart, source: `week:${win.weekSource}` };
  if (a.period === "since") return { since: a.since, source: "since" };
  return { since: 0, source: "all" };
}

interface AgentInfo { cwd?: string; sessionId?: string; runtime?: string }

export interface WakeCostDeps {
  agents: () => Promise<Record<string, AgentInfo>>;
  window: () => UsageWindowBounds;
  stateDir: string;
  /** 默认按 session-source 定位；测试注入临时目录 */
  resolvePath?: (info: AgentInfo) => string | null;
}

function defaultResolve(info: AgentInfo): string | null {
  if (!info.sessionId) return null;
  return (info.cwd ? sessionJsonlPath(info.runtime, info.cwd, info.sessionId) : null) ?? findSessionJsonlBySessionId(info.runtime, info.sessionId);
}

/** 命令主体：返回要打印的 JSON 或文本（不直接写 stdout，便于测试） */
export async function runWakeCost(args: string[], deps: WakeCostDeps): Promise<{ json: Record<string, unknown>; text: string }> {
  const fail = (error: string, extra: Record<string, unknown> = {}) => {
    const json = { ok: false, error, ...extra };
    return { json, text: error };
  };
  const a = parseWakeCostArgs(args);
  if ("error" in a) return fail(a.error);
  const info = (await deps.agents())[a.agent!];
  if (!info) return fail(`registry 里没有 agent：${a.agent}`);
  const runtime = info.runtime || DEFAULT_RUNTIME;
  if (runtime !== DEFAULT_RUNTIME) {
    const json = { ok: true, status: "unsupported", agent: a.agent, runtime, reason: "只支持 Claude Code 会话；其它运行时的叫醒语义未定，不伪造同口径数字" };
    return { json, text: `${a.agent}: unsupported（runtime=${runtime}）` };
  }
  const path = info.sessionId ? (deps.resolvePath ?? defaultResolve)(info) : null;
  const file = path ? Bun.file(path) : null;
  if (!path || !file || !(await file.exists())) {
    const json = { ok: true, status: "unknown", agent: a.agent, runtime, reason: "当前会话的记录文件不存在" };
    return { json, text: `${a.agent}: unknown（找不到当前会话记录）` };
  }
  if (runtimeForSessionPath(path) !== undefined) {
    return { json: { ok: true, status: "unsupported", agent: a.agent, runtime: runtimeForSessionPath(path), reason: "会话文件不是 Claude Code 格式" }, text: `${a.agent}: unsupported` };
  }
  const win = windowFor(a, deps.window());
  const report = buildWakeReport(a.agent!, info.sessionId!, scanWakes(await file.text(), win.since), win);
  const wrote = a.writeWeekly ? await writeWeeklySummary(deps.stateDir, report) : null;
  const json: Record<string, unknown> = { ...report, ...(wrote ? { weeklyFile: wrote } : {}) };
  return { json, text: renderWakeTable(report) + (wrote ? `\nweekly: ${wrote}` : "") };
}

export async function cmdWakeCost(args: string[]) {
  const { outputSync } = await import("./core.js");
  const { STATE_DIR } = await import("../lib/paths.js");
  const { readRegistryAgentsSync } = await import("../lib/registry.js"); // 只读：loadRegistry 在文件缺失时会新建
  const res = await runWakeCost(args, {
    agents: async () => Object.fromEntries(readRegistryAgentsSync().map((x) => [x.name, x as AgentInfo])),
    window: () => currentUsageWindow(),
    stateDir: STATE_DIR,
  });
  outputSync(args.includes("--json") ? res.json : res.text);
  if (res.json.ok === false) process.exitCode = 1;
}

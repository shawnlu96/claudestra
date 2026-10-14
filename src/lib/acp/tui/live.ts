/**
 * 底栏里「正在发生」的部分，只从 ACP 标准 session/update 读（不认适配器私有字段）：
 * - 工具调用：工具段（transcript.ts 的 ● 名字(摘要)）进来先挂在底栏，紧跟着的那条 tool_call 带来 toolCallId 和 kind；
 *   结果段配上紧跟着的 tool_call_update（completed / failed）的 toolCallId，连同工具头一起落进滚动记录——进行中只在底栏原地变，不另起新行。
 *   宿主总是先显示条目、再交原始更新（host.ts onUpdate），配对靠的就是这个顺序；没有更新跟着（单测、异常路径）就配最早那个在跑的。
 * - 思考（agent_thought_chunk）：只在底栏预览最后一整行（半行可能是半个密钥），换正文 / 工具 / 回合结束就收起。
 * - 状态栏要的：模型 / effort（config_option_update，或宿主出给 bridge 的 configOptions）、上下文（usage_update）、压缩中（compaction_update）。
 * tests/acp-tui-live.test.ts。
 */
import { redactSecrets } from "../../redact-secrets.js";
import { currentValueOf, parseConfigOptions } from "../config.js";
import type { ToolStatus } from "./blocks.js";

type Rec = Record<string, any>;

export interface LiveTool {
  id?: string;
  name: string;
  arg: string;
  kind?: string;
  status: ToolStatus;
  since: number;
}

/** 要落进滚动记录的一件：工具（可能没配上）+ 它的结果段（可能没有） */
export interface Settled {
  tool: LiveTool | null;
  result?: string;
}

export interface SessionInfo {
  model?: string;
  effort?: string;
  ctx?: { used: number; size?: number };
  compacting: boolean;
}

const TERMINAL = new Set(["completed", "failed"]);
/** 思考只留末尾这么多原文（预览只要最后几行） */
const THOUGHT_KEEP = 4_000;

export function createToolTracker(now: () => number) {
  let running: LiveTool[] = [], fresh: LiveTool[] = [], results: string[] = [];
  const take = (t: LiveTool | undefined): LiveTool | null => {
    if (!t) return null;
    running = running.filter((x) => x !== t);
    fresh = fresh.filter((x) => x !== t);
    return t;
  };
  const close = (t: LiveTool | null, result: string): Settled =>
    ({ tool: t && { ...t, status: result.startsWith("  ⎿ ✗") ? "fail" : "ok" }, result });
  /** 没有更新跟着的结果段：配最早那个在跑的（不动 fresh：工具段和它的结果段可能还在等同一条更新） */
  const orphans = (): Settled[] => {
    const out = results.map((r) => close(take(running[0]), r));
    results = [];
    return out;
  };
  return {
    running: (): readonly LiveTool[] => running,
    start(name: string, arg: string): void {
      const t: LiveTool = { name, arg, status: "running", since: now() };
      running = [...running, t];
      fresh = [...fresh, t];
    },
    result: (item: string): void => void (results = [...results, item]),
    /** 一条原始更新：给刚进来的工具配 id / kind；结果段配同 id 的工具定稿 */
    update(u: Rec): Settled[] {
      const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
      if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return orphans();
      if (!running.some((t) => t.id === id) && fresh.length) running = running.map((t) => (t === fresh.at(-1) ? { ...t, id } : t));
      fresh = [];
      running = running.map((t) => (t.id === id && typeof u.kind === "string" ? { ...t, kind: u.kind } : t));
      if (!results.length || !TERMINAL.has(u.status)) return [];
      const out = results.map((r) => close(take(running.find((t) => t.id === id) ?? running.find((t) => !t.id)), r));
      results = [];
      return out;
    },
    orphans,
    /** 回合结束还挂着的：按「未完成」落下去 */
    endTurn(): Settled[] {
      const out = [...orphans(), ...running.map((t): Settled => ({ tool: { ...t, status: "lost" } }))];
      [running, fresh] = [[], []];
      return out;
    },
  };
}

/** 思考预览：最后一整行，连同前两行一起打码（有的规则跨行：Bearer\n长串） */
export function createThought() {
  let raw = "";
  return {
    add(text: string): void {
      raw = (raw + text).slice(-THOUGHT_KEEP);
    },
    clear: (): void => void (raw = ""),
    active: (): boolean => raw.length > 0,
    preview(): string {
      const done = raw.slice(0, raw.lastIndexOf("\n") + 1);
      const lines = redactSecrets(done.split("\n").slice(-4).join("\n")).split("\n").filter((l) => l.trim());
      return lines.at(-1)?.trim() ?? "";
    },
  };
}

/** 状态栏的会话信息：只认标准事件；改了返回 true（要重画） */
export function createSessionInfo() {
  let info: SessionInfo = { compacting: false };
  const set = (next: SessionInfo): boolean => {
    const changed = JSON.stringify(next) !== JSON.stringify(info);
    info = next;
    return changed;
  };
  return {
    get: (): SessionInfo => info,
    config(raw: unknown): boolean {
      const opts = parseConfigOptions(raw);
      const model = currentValueOf(opts, "model"), effort = currentValueOf(opts, "reasoning_effort");
      return set({ ...info, ...(model ? { model: redactSecrets(model) } : {}), ...(effort ? { effort: redactSecrets(effort) } : {}) });
    },
    compacting: (on: boolean): boolean => set({ ...info, compacting: on }),
    update(u: Rec): boolean {
      switch (u.sessionUpdate) {
        case "usage_update":
          return typeof u.used === "number" && u.used > 0 ? set({ ...info, ctx: { used: u.used, ...(typeof u.size === "number" && u.size > 0 ? { size: u.size } : {}) } }) : false;
        case "config_option_update":
          return this.config(u.configOptions);
        case "compaction_update":
          return typeof u.status === "string" ? set({ ...info, compacting: !TERMINAL.has(u.status) && u.status !== "cancelled" }) : false;
        default:
          return false;
      }
    },
  };
}

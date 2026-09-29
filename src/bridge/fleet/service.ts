/**
 * 批量管理的服务层：收候选（registry + 大总管）、刷新 LP 状态、选人、并发跑、留痕。
 * HTTP（routes.ts）和 ws 请求（ws.ts：CLI 与 MCP 工具）都只调 runFleet / fleetState，权限在它们各自入口判；
 * 带 caller（MCP 工具，lib/fleet-caller.ts）时再按调用方收窄范围。
 * 生产 PaneIO 全走 tmux-helper：抓屏 capture-pane -p -e，打字 / 退格走 tmuxRawStrict（失败要抛），Esc 走 tmuxSendEscape 的双击护栏。
 */
import type { ServerWebSocket } from "bun";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeAgentStats } from "../../lib/agent-stats.js";
import { readConfigSync } from "../../lib/config-store.js";
import { FleetScopeError, scopeForCaller, visibleToCaller, type FleetCaller } from "../../lib/fleet-caller.js";
import {
  ACTION_LABEL, bareName, DEFAULT_COMPACT_KEEP, notApplicable, selectTargets, summarizeFleet,
  type Excluded, type FleetAction, type FleetCandidate, type FleetResult, type FleetSelect,
} from "../../lib/fleet-plan.js";
import { agentRuntime, readRegistryAgents } from "../../lib/registry.js";
import { ensurePaneInteractive, tmuxRawStrict, tmuxSendEscape } from "../../lib/tmux-helper.js";
import type { Envelope } from "../router.js";
import { newMessageId, newThreadId } from "../router.js";
import { auditFleet } from "./audit.js";
import { lpWindowOf, refreshLp, startLpMonitor, type LpSnapshot } from "./lp-monitor.js";
import { runOne, type PaneIO, type RunCtx, type TextOutcome } from "./runner.js";

interface Client { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }
export interface FleetDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<unknown>;
  controlChannelId?: string;
}

let deps: FleetDeps | null = null;
/** lpMonitor:false 只给单测：不起 30 秒一次的抓屏轮询（它会读真实 tmux socket） */
export function initFleet(d: FleetDeps, opts: { lpMonitor?: boolean } = {}): void {
  deps = d;
  if (opts.lpMonitor !== false) startLpMonitor(d.controlChannelId);
}

/** 这条 ws 在 clients 里注册的频道（register 时存的就是同一个 ws 对象）；manager CLI 的连接从不注册 → 空 */
export function connectionOf(ws: unknown): { channels: string[]; controlChannelId?: string } {
  const channels = deps ? [...deps.clients].filter(([, c]) => c.ws === ws).map(([id]) => id) : [];
  return { channels, controlChannelId: deps?.controlChannelId };
}

/** 同 tmuxSendLine（copy-mode 守卫 + 字面敲字 + 回车），但 tmux 失败就抛：它走 tmuxRaw 吞掉失败，超长的保留清单会变成「发了没反应」 */
async function sendLineStrict(w: string, text: string): Promise<void> {
  await ensurePaneInteractive(w);
  await tmuxRawStrict(["send-keys", "-t", w, "-l", "--", text]);
  await Bun.sleep(300);
  await tmuxRawStrict(["send-keys", "-t", w, "Enter"]);
}

const tmuxPaneIO: PaneIO = {
  capture: (w) => tmuxRawStrict(["capture-pane", "-t", w, "-p", "-e"]),
  sendLine: sendLineStrict,
  erase: async (w, n) => void (await tmuxRawStrict(["send-keys", "-t", w, ...Array<string>(n).fill("BSpace")])),
  escape: (w) => tmuxSendEscape(w),
  sleep: (ms) => Bun.sleep(ms),
};

function compactKeep(): string {
  const k = readConfigSync().fleet?.compactKeep;
  return typeof k === "string" && k.trim() ? k : DEFAULT_COMPACT_KEEP;
}

type Cand = FleetCandidate & { channelId?: string; cwd?: string };

async function candidates(): Promise<Cand[]> {
  const regs = await readRegistryAgents();
  const online = (cid?: string) => !!cid && !!deps?.clients.has(cid);
  const list: Cand[] = regs.map((r) => ({
    name: r.name, channelId: r.channelId, cwd: r.cwd, project: r.projectId, runtime: agentRuntime(r), master: false, online: online(r.channelId),
  }));
  const cc = deps?.controlChannelId;
  list.push({ name: "master", channelId: cc, runtime: "claude-code", master: true, online: online(cc) });
  return list;
}

function withLp(c: Cand, lp: Map<string, LpSnapshot>): Cand {
  const s = lp.get(bareName(c.name));
  return s ? { ...c, lowPriority: s.lowPriority, walled: s.walled } : c;
}

async function withContext(list: Cand[]): Promise<Cand[]> {
  const regs = await readRegistryAgents();
  const stats = await computeAgentStats(regs);
  const ctx = new Map(stats.map((s) => [bareName(s.name), s.contextTokens]));
  return list.map((c) => ({ ...c, contextTokens: ctx.get(bareName(c.name)) }));
}

/** 面板用：每个候选的最新 LP 状态（现抓一遍）；带 caller 只给它能操作的那些 */
export async function fleetState(caller?: FleetCaller): Promise<{ agents: (Cand & { lp?: LpSnapshot })[]; compactKeep: string }> {
  const all = await candidates();
  const list = caller ? visibleToCaller(caller, all) : all;
  const lp = await refreshLp(list.filter((c) => c.runtime === "claude-code" && c.online));
  const agents = (await withContext(list)).map((c) => ({ ...withLp(c, lp), lp: lp.get(bareName(c.name)) }));
  return { agents, compactKeep: compactKeep() };
}

export interface FleetRunRequest {
  action: FleetAction;
  select: FleetSelect;
  dryRun?: boolean;
  actor: string;
  via: string;
  /** MCP 工具的调用方（bridge 按连接认出）：按它收窄范围，下发文本用 notification */
  caller?: FleetCaller;
}
export interface FleetRunReport {
  runId: string;
  dryRun: boolean;
  action: FleetAction;
  targets: string[];
  results: FleetResult[];
  excluded: Excluded[];
  summary: string;
}

const CONCURRENCY = 4;

/**
 * 执行者（与 T36 的 isExecutor 同口径）：agent-task-*，或 cwd 在 git linked worktree 里（.git 是文件）。
 * 它的 /save-compact 解析到主仓的 memory 目录，会盖掉 PM 的 HANDOFF，所以 save-compact 对它一律改成 compact
 */
export function isExecutor(c: Pick<Cand, "name" | "cwd">): boolean {
  if (c.name.startsWith("agent-task-")) return true;
  for (let d = c.cwd; d && d !== dirname(d); d = dirname(d)) {
    const git = statSync(join(d, ".git"), { throwIfNoEntry: false });
    if (git) return git.isFile();
  }
  return false;
}

/** 对这个目标实际要跑的动作：执行者的 save-compact 改成 compact，note 是结果前面要加的说明（没改是空串） */
export function actionFor(action: FleetAction, t: Pick<Cand, "name" | "cwd">): { action: FleetAction; note: string } {
  if (action.kind !== "save-compact" || !isExecutor(t)) return { action, note: "" };
  return { action: { kind: "compact" }, note: "执行者改成 /compact（save-compact 会盖掉 PM 的 HANDOFF）：" };
}

async function runTarget(req: FleetRunRequest, t: Cand, ctx: RunCtx): Promise<FleetResult> {
  const na = notApplicable(req.action, t);
  if (na) return { agent: t.name, outcome: "skipped", detail: na }; // 离线 / 运行时不支持：没发键，算跳过（「全部」里常有停掉的旧条目）
  const { action, note } = actionFor(req.action, t);
  const r = await runOne(action, t.name, t.runtime === "claude-code" ? lpWindowOf(t.name) : null, ctx);
  return note ? { ...r, detail: note + r.detail } : r;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

function textSender(actor: string, via: string, count: number, intent: "request" | "notification") {
  return async (agent: string, text: string): Promise<TextOutcome> => {
    const cid = agent === "master" ? deps?.controlChannelId : (await readRegistryAgents()).find((r) => r.name === agent)?.channelId;
    const c = cid ? deps?.clients.get(cid) : undefined;
    if (!deps || !cid || !c) return { ok: false, error: "不在线" };
    const r = (await deps.deliver({
      from: { kind: "bridge", label: "fleet" },
      to: { kind: "local", channelId: cid, ws: c.ws as never, cwd: c.cwd },
      intent,
      content: `[📣 批量指令 · 来自 ${actor}（${via}）· 同时发给 ${count} 个 agent]\n${text}`,
      meta: { messageId: newMessageId("fleet"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
    })) as { outcome?: { kind?: string; note?: string; reason?: string; error?: Error } } | undefined;
    const o = r?.outcome;
    if (o?.kind === "sent") return { ok: true, queued: o.note === "queued" };
    return { ok: false, error: o?.kind === "dropped" ? `没送达：${o.reason}` : `投递出错：${o?.error?.message ?? "未知"}` };
  };
}

/** 预演：每个目标会做什么（离线 / 运行时不支持会跳过，执行者的 save-compact 改成 compact），调用方据此决定要不要真执行 */
function dryRunSummary(action: FleetAction, targets: Cand[]): string {
  const lines = targets.map((t) => {
    const na = notApplicable(action, t);
    const what = na ? `会跳过（${na}）` : actionFor(action, t).note ? "改成 /compact（执行者不跑 save-compact）" : ACTION_LABEL[action.kind];
    return `- ${bareName(t.name)}：${what}`;
  });
  // 第一行保持原样：网页面板只显示第一行
  return [`预演：会对 ${targets.length} 个 agent 执行（${targets.map((t) => bareName(t.name)).join("、") || "无"}）`, ...lines].join("\n");
}

export async function runFleet(req: FleetRunRequest, io: PaneIO = tmuxPaneIO): Promise<FleetRunReport> {
  const runId = `fl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // 先按调用方收窄再抓屏：PM 不去读别的项目的窗口
  const all = await candidates();
  const scoped = req.caller ? scopeForCaller(req.caller, req.action.kind, req.select, all) : { ok: true as const, cands: all, select: req.select, excluded: [] };
  if (!scoped.ok) throw new FleetScopeError(scoped.error);
  const lp = await refreshLp(scoped.cands.filter((c) => c.runtime === "claude-code" && c.online));
  let list = scoped.cands.map((c) => withLp(c, lp));
  if (req.select.ctxOver !== undefined) list = await withContext(list);
  const picked = selectTargets(list, scoped.select);
  const { targets } = picked;
  const excluded = [...scoped.excluded, ...picked.excluded];
  const names = targets.map((t) => t.name);
  if (req.dryRun) return { runId, dryRun: true, action: req.action, targets: names, results: [], excluded, summary: dryRunSummary(req.action, targets) };
  // MCP 的调用方是 agent：它下发的文本是知会，不挂 pending、不要求回复；网页 / CLI 是 owner 本人，照旧 request
  const ctx: RunCtx = { io, keep: compactKeep(), deliverText: textSender(req.actor, req.via, targets.length, req.caller ? "notification" : "request") };
  const results = await pool(targets, CONCURRENCY, (t) => runTarget(req, t, ctx));
  void refreshLp(targets.filter((t) => t.runtime === "claude-code").map((t) => ({ name: t.name, channelId: t.channelId })));
  const projectOf = new Map(targets.filter((t) => t.project).map((t) => [bareName(t.name), t.project!]));
  auditFleet({ runId, action: req.action, actor: req.actor, via: req.via, at: Date.now(), results, projectOf });
  return { runId, dryRun: false, action: req.action, targets: names, results, excluded, summary: summarizeFleet(req.action, results, excluded).text };
}

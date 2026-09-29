/**
 * 批量管理的服务层：收候选（registry + 大总管）、刷新 LP 状态、选人、并发跑、留痕。
 * HTTP（routes.ts）和 CLI 的 ws 请求（ws.ts）都只调 runFleet / fleetState，权限在它们各自入口判。
 * 生产 PaneIO 全走 tmux-helper：抓屏 capture-pane -p -e，打字 / 退格走 tmuxRawStrict（失败要抛），Esc 走 tmuxSendEscape 的双击护栏。
 * 压缩走 T36 的 injectCompact（ctx-boundary.ts）：执行者的 save-compact 在那里改成 compact，这里不再另判。
 */
import type { ServerWebSocket } from "bun";
import { computeAgentStats } from "../../lib/agent-stats.js";
import { readConfigSync } from "../../lib/config-store.js";
import {
  bareName, DEFAULT_COMPACT_KEEP, fleetKeep, notApplicable, selectTargets, summarizeFleet,
  type Excluded, type FleetAction, type FleetCandidate, type FleetResult, type FleetSelect,
} from "../../lib/fleet-plan.js";
import { agentRuntime, readRegistryAgents } from "../../lib/registry.js";
import { ensurePaneInteractive, tmuxRawStrict, tmuxSendEscape } from "../../lib/tmux-helper.js";
import { compactInjectedRecently, injectCompact, injectTargetFor } from "../ctx-boundary.js";
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
export function initFleet(d: FleetDeps): void {
  deps = d;
  startLpMonitor(d.controlChannelId);
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
  const k = fleetKeep(readConfigSync().fleet?.compactKeep);
  return k.ok ? k.keep : DEFAULT_COMPACT_KEEP;
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

/** 面板用：每个候选的最新 LP 状态（现抓一遍） */
export async function fleetState(): Promise<{ agents: (Cand & { lp?: LpSnapshot })[]; compactKeep: string }> {
  const list = await candidates();
  const lp = await refreshLp(list.filter((c) => c.runtime === "claude-code" && c.online));
  const agents = (await withContext(list)).map((c) => ({ ...withLp(c, lp), lp: lp.get(bareName(c.name)) }));
  return { agents, compactKeep: compactKeep() };
}

export interface FleetRunRequest { action: FleetAction; select: FleetSelect; dryRun?: boolean; actor: string; via: string }
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

async function runTarget(req: FleetRunRequest, t: Cand, ctx: RunCtx): Promise<FleetResult> {
  const na = notApplicable(req.action, t);
  if (na) return { agent: t.name, outcome: "skipped", detail: na }; // 离线 / 运行时不支持：没发键，算跳过（「全部」里常有停掉的旧条目）
  return runOne(req.action, t.name, t.runtime === "claude-code" ? lpWindowOf(t.name) : null, ctx);
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

function textSender(actor: string, via: string, count: number) {
  return async (agent: string, text: string): Promise<TextOutcome> => {
    const cid = agent === "master" ? deps?.controlChannelId : (await readRegistryAgents()).find((r) => r.name === agent)?.channelId;
    const c = cid ? deps?.clients.get(cid) : undefined;
    if (!deps || !cid || !c) return { ok: false, error: "不在线" };
    const r = (await deps.deliver({
      from: { kind: "bridge", label: "fleet" },
      to: { kind: "local", channelId: cid, ws: c.ws as never, cwd: c.cwd },
      intent: "request",
      content: `[📣 批量指令 · 来自 ${actor}（${via}）· 同时发给 ${count} 个 agent]\n${text}`,
      meta: { messageId: newMessageId("fleet"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
    })) as { outcome?: { kind?: string; note?: string; reason?: string; error?: Error } } | undefined;
    const o = r?.outcome;
    if (o?.kind === "sent") return { ok: true, queued: o.note === "queued" };
    return { ok: false, error: o?.kind === "dropped" ? `没送达：${o.reason}` : `投递出错：${o?.error?.message ?? "未知"}` };
  };
}

export async function runFleet(req: FleetRunRequest, io: PaneIO = tmuxPaneIO): Promise<FleetRunReport> {
  const runId = `fl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let list = await candidates();
  const lp = await refreshLp(list.filter((c) => c.runtime === "claude-code" && c.online));
  list = list.map((c) => withLp(c, lp));
  if (req.select.ctxOver !== undefined) list = await withContext(list);
  const { targets, excluded } = selectTargets(list, req.select);
  const names = targets.map((t) => t.name);
  if (req.dryRun) {
    return { runId, dryRun: true, action: req.action, targets: names, results: [], excluded, summary: `预演：会对 ${names.length} 个 agent 执行（${names.map(bareName).join("、") || "无"}）` };
  }
  const ctx: RunCtx = {
    io,
    keep: compactKeep(),
    deliverText: textSender(req.actor, req.via, targets.length),
    compact: async (agent, action, keep) => injectCompact(await injectTargetFor(agent), { action, keep }),
    compactedRecently: async (agent) => compactInjectedRecently((await injectTargetFor(agent)).target),
  };
  const results = await pool(targets, CONCURRENCY, (t) => runTarget(req, t, ctx));
  void refreshLp(targets.filter((t) => t.runtime === "claude-code").map((t) => ({ name: t.name, channelId: t.channelId })));
  const projectOf = new Map(targets.filter((t) => t.project).map((t) => [bareName(t.name), t.project!]));
  auditFleet({ runId, action: req.action, actor: req.actor, via: req.via, at: Date.now(), results, projectOf });
  return { runId, dryRun: false, action: req.action, targets: names, results, excluded, summary: summarizeFleet(req.action, results, excluded).text };
}

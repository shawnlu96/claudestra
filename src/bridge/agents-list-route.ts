/**
 * GET /api/v1/agents —— scope 内的 agent 快照（从 api-routes.ts 搬出的热点；路由分发仍在那边）。
 * 顺序是硬要求：先按凭据 scope 筛，再读会话尾——先读整个 registry 再按 scope 丢的话，几百个已停出借 worker 的串行尾读
 * 就把列表接口拖过网页的请求超时（复现见 tests/api-agents-list-recovery.test.ts）。
 * 已停的出借 worker（lib/worker-kind.ts 判定）不读尾、不找 Codex rollout、不探 pane：只保留列表需要的最小元数据，
 * 隐藏 / 归档规则照旧。活会话与已停的普通会话走全局有界并发 + 短缓存（agents-list-tails.ts）。
 * 字段语义（busy / model / effort / contextTokens / lastActivityTs / projectId / archived）与搬出前逐字段相同。
 */
import { existsSync } from "node:fs";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { agentInScope, type Principal } from "../lib/principals.js";
import { sourceFor } from "../lib/runtimes/index.js";
import { USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import { displayModelEffort } from "../lib/display-model.js";
import { cachedCodexCatalog, readCodexConfigDefaults } from "../lib/codex-catalog.js";
import { readPiRuntimeSnapshot } from "../lib/pi-env.js";
import { resolveModelAlias } from "../lib/claude-launch.js";
import { paneLooksWorking } from "../lib/turn-state.js";
import { paneTail } from "../lib/pane-tail.js";
import { tmuxRaw, windowTarget } from "../lib/tmux-helper.js";
import type { SessionTailInfo } from "../lib/session-tail.js";
import { apiJson } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";
import { agentListExtras, type AgentListExtras } from "./agent-info-routes.js";
import { ctxBoundaryViewFor } from "./ctx-boundary.js";
import { pickSwitchOverride } from "./switch-override.js";
import { latestSessionIdForCwd } from "./session-ids.js";
import { MASTER_DIR } from "./config.js";
import { readSessionTails, type TailIo, type TailTarget } from "./agents-list-tails.js";

export interface AgentsListIo {
  /** bridge/management.ts 的 runManager（枢纽模块，不在这里 import，由 api-routes 注入） */
  runManager: (...args: string[]) => Promise<{ agents?: unknown[] }>;
  /** ws 会话表：只取 master 的 cwd */
  clients: Map<string, { cwd?: string }>;
  /** master 的控制频道 id（空 = 没配 master） */
  controlChannelId: string;
  /** 会话尾读的 IO（单测注入计数 / 假延迟；生产用默认） */
  tails?: TailIo;
}

/** 列表里的一行：manager list 的原始字段 + 这里逐步附上的展示字段（老实现就是 any，这里只收紧到有名字的几项） */
type Row = Record<string, unknown> & { name: string; status?: string; idle?: boolean; busy?: boolean; archived?: boolean };

interface ClaudeGlobals {
  model: string | null;
  effort: string | null;
}

export async function handleAgentsList(url: URL, principal: Principal, io: AgentsListIo): Promise<Response> {
  try {
    return apiJson(200, { ok: true, agents: await listAgentsForPrincipal(url, principal, io) });
  } catch (e) {
    return apiJson(500, { ok: false, error: (e as Error).message });
  }
}

async function listAgentsForPrincipal(url: URL, principal: Principal, io: AgentsListIo): Promise<Row[]> {
  const listResult = await io.runManager("list");
  const extras = await agentListExtras(principal); // external / 显示名 / 已归档 / 共享数（bridge/agent-info-routes.ts）
  const regs = await readRegistryAgents();
  const regByName = new Map(regs.map((r) => [r.name, r]));
  // 先 scope 后 IO：scope 外的会话一个字节都不读
  const rows = ((listResult.agents || []) as Row[]).filter((a) => agentInScope(principal, a.name)).map((a) => baseRow(a, principal));
  await Promise.all(rows.map((a) => attachBusyFlags(a)));
  const tails = await readSessionTails(rows.flatMap((a) => tailTargetFor(a.name, regByName.get(a.name))), io.tails);
  const globals = await claudeGlobalDefaults();
  for (const a of rows) attachSessionFields(a, regByName.get(a.name), tails.get(a.name) ?? null, extras, globals);
  // 「该重启/该 pi update」提示：不给 peer（不向别的实例透露本机确切版本）；出任何错都只少个提示，不能让整张列表 500
  // 动态 import 与搬出前一致：静态 import 会让 guard 的 dead 规则开始检查 update-hints 的全部导出（VersionProbe 没人用，改它不在本卡范围）
  if (!principal.peer) await import("../lib/update-hints.js").then((m) => m.attachUpdateHints(rows, regByName))
    .catch((e) => console.warn("⚠️ [api] 更新提示附加失败（列表照常返回）:", e));
  // ?include=stopped：registry 里已停止的 agent 也入列（additive；web 侧栏保留 stopped 会话入口，其历史经归档仍可读）
  if (url.searchParams.get("include") === "stopped") rows.push(...(await stoppedRows(regs, new Set(rows.map((a) => a.name)), principal, extras, io.tails)));
  // master 入列（token scope 显式含 "master" 才可见，"*" 不含）。web 前端的「大总管」置顶入口靠它
  if (io.controlChannelId && agentInScope(principal, "master")) rows.unshift(await masterRow(io, extras, globals));
  return rows;
}

function baseRow(a: Row, principal: Principal): Row {
  return {
    name: a.name,
    status: a.status,
    idle: a.idle,
    purpose: a.purpose,
    cwd: principal.peer ? undefined : a.cwd, // cwd 给 web「在 Finder 中显示」用；peer 拿不到我方本机路径
    created: a.created,
  };
}

/**
 * busy：正在回合中（hook 驱动的 agent_status，与 /pending 的 thinking 同源——manager list 的 tmux idle 探测在回合中也常报 idle，
 * 不可靠，只作 OR 兜底）。第三信号：bridge 重启后 event-bus 清零、回合中途没有新事件，状态不明的 active agent 补一发
 * pane spinner 探测（与 deliverToLocal 抢占判据同款三信号）。已停止的行不探（没有窗口）。
 */
async function attachBusyFlags(a: Row): Promise<void> {
  const st = getAgentStatus(a.name) ?? getAgentStatus(a.name.replace(/^agent-/, ""));
  a.busy = isBusyStatus(st) || a.idle === false;
  a.archived = existsSync(`${USER_ARCHIVE_ROOT}/${a.name.replace(/^agent-/, "")}`); // 归档区里有它的目录 ⇒ 网页把它从工作列表隐藏
  a.compacting = st === "compacting"; // 正在压缩上下文（侧栏/列表可区分于普通忙碌）
  if (a.busy || st !== undefined || a.status === "stopped") return;
  try {
    const tail = paneTail(await tmuxRaw(["capture-pane", "-t", windowTarget(a.name), "-p"]), 10).join("\n");
    if (paneLooksWorking(tail)) a.busy = true;
  } catch {
    /* 窗口不存在等：保持不忙 */
  }
}

/**
 * 有 cwd + sessionId 才有会话文件可读。Codex 的 rollout 路径由 cwd + id 推不出来、只能按 id 全库找：
 * 活会话和已停的普通会话都允许（否则已停的普通 Codex 永远没有 lastActivity），已停的出借 worker 根本不进这里。
 */
function tailTargetFor(name: string, r: RegistryAgent | undefined): TailTarget[] {
  return r?.cwd && r.sessionId ? [{ name, runtime: r.runtime, cwd: r.cwd, sessionId: r.sessionId, findById: true }] : [];
}

/** model / effort 兜底链末端：全局默认（settings.json） */
async function claudeGlobalDefaults(): Promise<ClaudeGlobals> {
  const out: ClaudeGlobals = { model: null, effort: null };
  try {
    const s = JSON.parse(await Bun.file(`${process.env.HOME}/.claude/settings.json`).text());
    if (typeof s.model === "string") out.model = s.model;
    if (typeof s.effortLevel === "string") out.effort = s.effortLevel;
  } catch {
    /* 无全局默认 */
  }
  return out;
}

/**
 * lastActivityTs：agent 最后一条真实对话的时间（不是 mtime——见 lib/session-tail.ts）；contextTokens：当前上下文占用；
 * 读不到（没文件 / 坏文件）一律 null，前端按 unknown 展示。
 */
function attachSessionFields(a: Row, r: RegistryAgent | undefined, info: SessionTailInfo | null, extras: AgentListExtras, globals: ClaudeGlobals): void {
  a.lastActivityTs = info?.convTs ?? null;
  a.contextTokens = info?.ctxTokens ?? null;
  a.ctxBoundary = r ? ctxBoundaryViewFor(r, info?.ctxTokens ?? null) : null; // 命中的上下文边界 + 余量（bridge/ctx-boundary.ts）
  a.projectId = r?.projectId ?? null; // project 归属（web 侧栏分组数据源；master 特判无此字段）
  Object.assign(a, { ...extras(a.name, r), archived: a.archived }); // archived 以 attachBusyFlags 那份为准（生效路径）
  // 运行时徽章 + 顶栏挂哪种切换器的数据源：如实透传（未知/缺失 = claude-code），只认 pi 的话 Codex 会拿到 CC 面板
  const runtime = sourceFor(r?.runtime).id;
  a.runtime = runtime;
  a.contextWindow = info?.ctxWindow ?? null; // Codex 的窗口随会话记录走（258K 之类）
  // 当前模型 / 档位的兜底链按运行时分叉（lib/display-model.ts）
  Object.assign(a, displayModelEffort({
    runtime,
    override: pickSwitchOverride(a.name, info),
    tail: info,
    reg: r,
    claudeGlobal: globals,
    piSnapThinking: r?.runtime === "pi" ? (readPiRuntimeSnapshot(a.name)?.thinking ?? null) : null,
    codex: r?.runtime === "codex" ? { catalog: cachedCodexCatalog(), config: readCodexConfigDefaults() } : undefined,
    resolveAlias: resolveModelAlias,
  }));
}

/**
 * registry 里已停止、不在 manager list 里的 agent。已停的出借 worker 只带最小元数据（lastActivityTs 为 null）：
 * 网页列表对它们只需要名字 / 归档 / 归属，而它们数量最多、会话尾 / rollout 查找最贵。已停的普通会话照常读尾。
 * 归档标记必须在这条独立路径也带一份（extras 里有），漏了的话灰点的归档 agent 照样留在列表里。
 */
async function stoppedRows(regs: RegistryAgent[], listed: Set<string>, principal: Principal, extras: AgentListExtras, tailIo?: TailIo): Promise<Row[]> {
  const cands = regs.filter((r) => !listed.has(r.name) && agentInScope(principal, r.name)).map((r) => ({ r, fields: extras(r.name, r) }));
  const targets = cands.filter(({ fields }) => fields.kind !== "worker").flatMap(({ r }) => tailTargetFor(r.name, r));
  const tails = await readSessionTails(targets, tailIo);
  return cands.map(({ r, fields }) => ({
    name: r.name,
    status: "stopped",
    idle: undefined,
    purpose: r.purpose,
    lastActivityTs: tails.get(r.name)?.convTs ?? null,
    created: (r as { created?: unknown }).created,
    projectId: r.projectId ?? null,
    runtime: sourceFor(r.runtime).id,
    ...fields,
  }));
}

/** master 不在 registry：model/effort probe 其 cwd 最新 jsonl；jsonl 实测之外只剩全局默认这级兜底 */
async function masterRow(io: AgentsListIo, extras: AgentListExtras, globals: ClaudeGlobals): Promise<Row> {
  let mInfo: SessionTailInfo | null = null;
  try {
    const mCwd = io.clients.get(io.controlChannelId)?.cwd || MASTER_DIR;
    const mSid = latestSessionIdForCwd(mCwd);
    if (mCwd && mSid) {
      mInfo = (await readSessionTails([{ name: "master", runtime: "claude-code", cwd: mCwd, sessionId: mSid }], io.tails)).get("master") ?? null;
    }
  } catch {
    /* master 会话 probe 失败不影响列表 */
  }
  const st = getAgentStatus("master");
  return {
    name: "master",
    status: io.clients.has(io.controlChannelId) ? "active" : "stopped",
    idle: undefined,
    purpose: "master orchestrator (大总管)",
    busy: isBusyStatus(st),
    compacting: st === "compacting",
    runtime: "claude-code",
    contextTokens: mInfo?.ctxTokens ?? null,
    ...displayModelEffort({ runtime: "claude-code", override: pickSwitchOverride("master", mInfo), tail: mInfo, reg: undefined, claudeGlobal: globals, resolveAlias: resolveModelAlias }),
    ...extras("master"), // 附加字段（Autopilot 等，agent-info-routes.ts）；master 不在 registry，external / 显示名恒为空
  };
}

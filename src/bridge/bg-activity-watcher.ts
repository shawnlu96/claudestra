/**
 * v2.8+ bg 活动追踪 —— subagent / 后台 shell 任务的发现 + 子区流式呈现。
 *
 * 两类后台活动（都归属于某个注册 agent 的当前 session）：
 *   - subagent：Claude Code 把每个 Agent 工具调用的对话独立落盘在
 *     ~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl，与主会话同格式
 *   - 后台 shell（run_in_background Bash）：实时输出写在
 *     /tmp/claude-<uid>/<slug>/<sessionId>/tasks/<taskId>.output 纯文本
 *
 * 呈现：每个活动在 owner agent 的主会话下开一个「子会话」（ChatAdapter.provisionThread，
 * Discord = thread 子区），把工具调用 / 文本 / shell 输出流进去，结束发总结 + 归档。
 * 主频道零污染。全程 transport 中立：adapter 没有 provisionThread 能力就只发事件。
 *
 * 事件：bg_task_started / bg_task_update / bg_task_completed（SSE 同步可见，
 * web 前端可以不依赖 Discord 自行渲染进度线）。
 *
 * 结束判定：subagent 认记录里的真信号（答复 / 中断 / meta 的 stoppedByUser，规则见 lib/subagent-progress.ts），
 * 在跑工具时静默再久也不收尾；后台 shell 只认 CC 追加的独立末行 `[exited with code N]` / `[killed]`（lib/bg-shell-progress.ts），
 * 静默再久也不收尾（重定向日志的 bun test 可以十几分钟不写一字）；输出文件消失 = 状态未知，不当成功；
 * 输出读不到（权限 / IO）不收尾、照旧重试，但经事件 / 快照的 progress.unreadable 告诉前端「状态未知」。
 * 已跟踪 shell 的最小结局按 agent-session 持久化，web 刷新 / bridge 重启后据此还原。
 *
 * 重启防重放：每个 agent-session **首次进入监视**的那轮 poll 把不活跃的已有文件记成 baseline（标记 seen 不开流），
 * 只有最近还在写的「在跑」任务照常开流（firstScanLive）；当存量 / 已收尾的 subagent 之后又被续跑，按身份接回
 * （wakeDormantSubagents）—— bridge 重启既不会把历史 subagent 全部重播一遍，也不会丢掉正在跑的。
 * 作用域是 agent × session 而不是进程（lib/baseline-keys.ts，
 * 2026-09-07 peer 报 109 张幽灵卡：进程级单标志下，首轮 tick 时 sessionId 还没写回
 * registry 的 agent，22 分钟后进入列表时存量 109 个 subagent jsonl 全被开成「运行中」）。
 *
 * 会话轮转（原生 /clear 等）：在跑的 subagent 续写进新会话目录的同名文件，按身份换绑接着读（rebindRotated）；
 * 后台 shell 仍写进 CC 进程启动时那个会话的 tasks/，按 CC 在主会话里报的目录一并列出（shellDirsFor、lib/bg-shell-dirs.ts）。
 */

import { constants as fsConstants, existsSync } from "fs";
import { access, lstat, readdir, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import { projectsSlug, projectJsonlPath, subagentsDir } from "../lib/jsonl-cost.js";
import { readActiveAgents } from "../lib/registry.js";
import { adapterFor, type ChatAdapter } from "./adapters.js";
import { parseChatId } from "./router.js";
import { emitEvent } from "./event-bus.js";
import { formatTool } from "./jsonl-watcher.js";
import { recordMetric } from "../lib/metrics.js";
import { ShellResults } from "../lib/bg-shell-results.js";
import { BaselineKeys } from "../lib/baseline-keys.js";
import { findSessionOutput, ReportedShellDirs } from "../lib/bg-shell-dirs.js";
import { feedShellChunk, newShellProgress, settleShellTail, type ShellProgress } from "../lib/bg-shell-progress.js";
import type { ShellEnd } from "../lib/shell-end-line.js";
import {
  EMPTY_PROGRESS, foldProgress, hasUserRecord, nextProgress, readFirstRecord, readSubagentMeta, subagentEndStatus, type SubagentMeta, type SubagentProgress,
} from "../lib/subagent-progress.js";

const POLL_MS = 10_000;
const FLUSH_MS = 2_500; // 子区推送 debounce（Discord 限速友好）
const SUBAGENT_SILENT_LIMIT_MS = 30 * 60_000; // subagent 既没交答复也没被停止（在跑工具 / 等模型）、却 30min 一行不写 → 按「无动静」收尾
const MAX_MSG_LEN = 1900;
const MAX_ACTIVE_PER_AGENT = 8; // 防 thread 轰炸（workflow 大扇出时超出的只发事件）
const MAX_TEXT_PER_ITEM = 400; // subagent 单条文本进子区的截断长度
const SHELL_MISSING_GRACE_MS = 60_000; // shell 启动 / 上次有输出后这么久内输出文件不见了，只算「还没出现」（见 consume）

type BgActivityKind = "subagent" | "shell";

interface Activity {
  key: string; // 全局唯一（文件路径）
  /** 对外稳定 id（文件 basename 去后缀：subagent = "agent-xxx"，shell = taskId）——
   *  SSE 事件用它做关联键，不外泄服务器绝对路径 */
  id: string;
  kind: BgActivityKind;
  agentName: string;
  sessionId: string;
  ownerChatId: string;
  filePath: string;
  threadId: string | null; // 建 thread 失败 → null，只发事件
  adapter: ChatAdapter | null;
  offset: number; // 已消费字节
  lastGrowth: number;
  startedAt: number;
  queue: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  eventCount: number;
  finished: boolean;
  /** 已 flush 的渲染行尾部环形缓冲（封顶 RECENT_MAX）——web 端刷新/连流后
   *  replay 活跃任务用（GET /api/v1/agents/:name/bg-tasks），不然面板一刷新就空 */
  recent: string[];
  meta: SubagentMeta; // subagent 才有内容（描述 / 类型 / 模型 / 是否被停止），每轮 tick 重读
  progress: SubagentProgress;
  /** shell 才用：跨读的半行 / 流式解码状态 */
  shell: ShellProgress;
  /** shell 读到独立终止行后的结局：退出行（0 / 非 0 都是「进程已结束」）或 [killed]（被结束） */
  end: ShellEnd | null;
  /** shell 输出文件当前读不了（权限 / IO）：照旧每轮重试，同时经事件 / 快照告诉前端「状态未知」，读通后清掉 */
  unreadable: boolean;
  /** 续跑接回的 subagent 上一轮被停过：meta 里的 stoppedByUser 是旧的（CC 续跑不清它），这一轮只认记录里的中断标记 */
  staleStop: boolean;
  /** 新会话目录里没有 meta.json 时从哪个 jsonl 旁读 meta：换绑前的旧文件（见 metaFor） */
  metaPath: string;
}

const RECENT_MAX = 100;

interface AgentLite {
  name: string;
  channelId: string;
  cwd: string;
  sessionId: string;
}

const activities = new Map<string, Activity>();
/** 见过的文件（含 baseline + 已结束的），防重复开流 */
const seen = new Set<string>();
/** shell 候选（等待 jsonl 确认是真 bg 任务）：filePath → 首见时间 */
const shellCandidates = new Map<string, number>();
/** 因输出文件消失判了 unknown 的已确认 shell：文件再出现就按原身份接着跟——不算新文件（不过洪水闸），也不再做真 bg 确认
 *  （首次跟踪时确认过）。所在会话目录被清理就不会再出现，每小时随 seen 瘦身一起清掉 */
const missingShells = new Set<string>();
/** 休眠的 subagent 记录（已收尾 / 首轮当存量）：路径 → 已读到的字节位置。又长出 user 记录 = 被 SendMessage 续跑，
 *  从这里按原身份接着跟（不算新文件，不过洪水闸）。文件被清理后随每小时 seen 瘦身一起清掉 */
const dormantSubagents = new Map<string, number>();
/** 首轮扫描时这么久内写过的 shell 算「在跑」，照常开流（与 shell 消失宽限期同级）；subagent 按有没有收尾分，见 firstScanLive */
const RECENT_MS = 120_000;
const SHELL_CONFIRM_TIMEOUT_MS = 60_000;
/** CC 在主会话里报过的 shell 输出目录（会话轮转后仍写旧会话的 tasks/） */
const reportedDirs = new ReportedShellDirs();
/** 真 bg 确认超时、当前台瞬时文件跳过的 shell：轮转后 registry 跟上之前，确认读的还是旧会话 jsonl，新会话里开的 shell 会被误跳过；
 *  之后它的 id 出现在当前会话 CC 的结构化启动结果里就接回跟踪（reviveLateConfirmed）。文件被清理后每小时瘦身清掉 */
const unconfirmedShells = new Set<string>();
/** 已列过的 agent × shell 目录：新冒出来的目录（bridge 重启后才从报告里认出的旧 tasks/）先走首轮分拣，免得几百个旧文件回放 */
const listedShellDirs = new Set<string>();
/** 按 agent-session 记「首次进入监视」——见文件头「重启防重放」 */
const baseline = new BaselineKeys();
/** 测试接缝：时钟 / agent 列表 / shell 任务目录（默认即生产行为；tests/bg-activity-shell*.test.ts 用真实文件 + 可控时钟驱动） */
interface WatcherDeps {
  now: () => number;
  agents: () => Promise<AgentLite[]>;
  shellDir: (cwd: string, sessionId: string) => string;
}
let ticking = false; // tick 重入保护：首轮 baseline 超过 POLL_MS 时 interval 会并发进入
let tickCount = 0;

// ── 目录定位 ───────────────────────────────────────────────────────────

function shellTasksDirFor(cwd: string, sessionId: string): string {
  // Claude Code 的 session scratchpad 根：/tmp/claude-<uid>/<slug>/<sessionId>/
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join("/tmp", `claude-${uid}`, projectsSlug(cwd), sessionId, "tasks");
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(suffix)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * 真 bg 任务确认（2026-07-10 实战教训）：**前台** Bash 调用也会在 tasks/ 下落一个
 * 瞬时 .output（命令结束即删）—— 不过滤的话每个长命令都会开一个子区然后秒归档。
 * run_in_background 的任务 id 会出现在主会话 jsonl 的 tool_result 文本里
 * （"Command running in background with ID: <id>"），拿它做权威判定；jsonl 写入
 * 可能比文件晚一拍，确认不了先挂 candidate 下轮再试，超时放弃。
 */
async function isRealBgTask(agent: AgentLite, taskId: string): Promise<boolean> {
  try {
    const f = Bun.file(projectJsonlPath(agent.cwd, agent.sessionId));
    const size = f.size;
    const tail = await f.slice(Math.max(0, size - 512_000), size).text();
    return tail.includes(taskId);
  } catch {
    return false;
  }
}

async function watchableAgents(): Promise<AgentLite[]> {
  return (await readActiveAgents())
    .filter((a) => a.channelId && a.sessionId && a.cwd)
    .map((a) => ({ name: a.name, channelId: a.channelId!, cwd: a.cwd!, sessionId: a.sessionId! }));
}

const deps: WatcherDeps = { now: () => Date.now(), agents: watchableAgents, shellDir: shellTasksDirFor };

/** 测试用：换掉部分依赖后跑一轮 poll（与 setInterval 那轮同一个 tick） */
export function pollBgActivitiesForTest(over: Partial<WatcherDeps>): Promise<void> {
  Object.assign(deps, over);
  return tick();
}

// ── 活动生命周期 ───────────────────────────────────────────────────────

/** v2.20.2+ 导出给 Stop hook:回合结束时该 agent 是否还有后台活动在跑
 *  (subagent / bg shell)。有 → done 事件带 bgPending,web 不标绿勾标「后台
 *  继续中」(owner 实报「长任务经常提前变成完成」——完成跟的是回合边界,而
 *  长任务的回合常在等后台时先收尾)。名字两侧都可能带 agent- 前缀,归一比较。 */
export function hasActiveBgActivities(agentName: string): boolean {
  const norm = agentName.replace(/^agent-/, "");
  for (const a of activities.values()) {
    if (!a.finished && a.agentName.replace(/^agent-/, "") === norm) return true;
  }
  return false;
}

function activeCountFor(agentName: string): number {
  let n = 0;
  for (const a of activities.values()) if (a.agentName === agentName && !a.finished) n++;
  return n;
}

function titleFor(kind: BgActivityKind, filePath: string): string {
  const base = basename(filePath).replace(/\.(jsonl|output)$/, "");
  return kind === "subagent" ? `🤖 subagent ${base.replace(/^agent-/, "").slice(0, 20)}` : `🐚 bg shell ${base}`;
}

/** 活动的初始状态（新开 / 续跑接回 / 重启后接着读共用）；startedAt 不给就是现在，offset 不给就从头读 */
function newActivity(
  kind: BgActivityKind,
  agent: AgentLite,
  filePath: string,
  o: Pick<Activity, "threadId" | "adapter" | "meta"> & { startedAt?: number; offset?: number },
): Activity {
  return {
    key: filePath,
    id: basename(filePath).replace(/\.(jsonl|output)$/, ""),
    kind,
    agentName: agent.name,
    sessionId: agent.sessionId,
    ownerChatId: agent.channelId,
    filePath,
    threadId: o.threadId,
    adapter: o.adapter,
    offset: o.offset ?? 0,
    lastGrowth: deps.now(),
    startedAt: o.startedAt ?? deps.now(),
    queue: [],
    flushTimer: null,
    eventCount: 0,
    finished: false,
    recent: [],
    meta: o.meta,
    progress: EMPTY_PROGRESS,
    shell: newShellProgress(),
    end: null,
    unreadable: false,
    staleStop: !!o.offset && o.meta.stoppedByUser === true,
    metaPath: filePath,
  };
}

/** 换绑过的 subagent：新会话目录里 CC 没写 meta.json，就读换绑前那份（标题 / 停止标记） */
function metaFor(act: Activity): SubagentMeta {
  return readSubagentMeta(existsSync(act.filePath.replace(/\.jsonl$/, ".meta.json")) ? act.filePath : act.metaPath);
}

/** offset：续跑接回的 subagent 从休眠位置读起，不把上一轮的记录再推一遍；startedAt：迟到确认的 shell 按输出文件建出的时刻算 */
async function startActivity(
  kind: BgActivityKind,
  agent: AgentLite,
  filePath: string,
  offset = 0,
  startedAt?: number,
): Promise<void> {
  seen.add(filePath);
  const meta = kind === "subagent" ? readSubagentMeta(filePath) : {};
  const title = meta.description ? `🤖 ${meta.description}` : titleFor(kind, filePath);
  const { transport } = parseChatId(agent.channelId);
  const adapter = adapterFor(transport);

  // 按来源分流：上一回合从 Web/API 来就不在 Discord 建子区（agent.channelId 永远是 Discord 频道，无条件建
  // 会让纯 Web 用户每起一个 subagent 就收一条 Discord 通知；Web 靠 bg_task_* 事件渲染）。来源不明保持建。
  const src = sourceProvider?.(agent.channelId);
  const wantThread = src !== "api";

  let threadId: string | null = null;
  if (wantThread && adapter?.provisionThread && activeCountFor(agent.name) < MAX_ACTIVE_PER_AGENT) {
    try {
      const r = await adapter.provisionThread(agent.channelId, title);
      threadId = r.chatId;
    } catch (e) {
      console.error(`🧵 建子区失败 (${agent.name} ${title}):`, (e as Error).message);
    }
  }

  const act = newActivity(kind, agent, filePath, { threadId, adapter, meta, offset, startedAt });
  activities.set(filePath, act);
  if (kind === "shell") await shellResults.remember({ ...act, exitCode: null });
  console.log(
    `🧵 bg 活动开始: ${agent.name} ${title}` +
      (threadId ? ` → thread ${threadId}` : wantThread ? "（无子区，仅事件）" : "（Web 回合，只发事件不建子区）"),
  );
  recordMetric("bg_activity_started", { agent: agent.name, meta: { kind } });
  emitEvent({
    agent: agent.name,
    chatId: agent.channelId,
    type: "bg_task_started",
    data: { kind, id: act.id, threadId, title, agentType: meta.agentType, model: meta.model, ...(kind === "shell" ? { progress: progressView(act) } : {}) },
  });
}

/**
 * bridge 重启前在跟踪、结局记成 unknown 的 shell（多半是重启时进程还在跑）：首轮 baseline 会把它的输出当存量不再读，结局就永远停在
 * unknown。输出还在且是普通文件（软链是 subagent 对话记录）就接着读：已写完的按末行更正（时长截到文件最后写入时刻），没写完的继续跟到
 * 终止行。不建子区、不发开始事件——前端已有这张「状态未知」卡，只发进度 / 结局把它更正过来；文件不在就保持 unknown。
 */
async function resumeUnknownShells(agent: AgentLite, shellFiles: string[]): Promise<void> {
  for (const r of shellResults.snapshots(agent.name)) {
    if (r.end.status !== "unknown") continue;
    // 不在已列出的目录里 = 轮转前开始的，输出在旧会话的 tasks/：按 id 在同一根下各会话目录里找（lib/bg-shell-dirs.ts）
    const filePath = shellFiles.find((f) => basename(f) === `${r.id}.output`) ?? (await findSessionOutput(dirname(dirname(deps.shellDir(agent.cwd, agent.sessionId))), r.id));
    if (!filePath || activities.has(filePath)) continue;
    const st = await lstat(filePath).catch(() => null); // lstat 失败 = 刚被删，和文件不在一样保持 unknown
    if (!st?.isFile()) continue;
    seen.add(filePath);
    const act = newActivity("shell", agent, filePath, { threadId: null, adapter: null, meta: {}, startedAt: r.startedAt });
    activities.set(filePath, act);
    console.log(`🧵 bg shell 重启前结局未知、输出仍在，接着读: ${agent.name} ${act.id}`);
    await consume(act).catch((e) => console.error(`🧵 bg shell 重启后读取失败 (${agent.name} ${act.id}):`, (e as Error).message));
    if (act.end) await finalize(act, act.end.status, "重启后按末行更正", st.mtimeMs);
    else emitProgress(act);
  }
}

/**
 * 首轮扫描（bridge 重启 / 新会话）的分拣：不活跃的已有文件当存量，只留下「在跑」的照常开流。subagent 看有没有收尾（交了答复 /
 * 被停止 / 静默超过 SUBAGENT_SILENT_LIMIT_MS）：没收尾的哪怕静默了几分钟（在想、在跑长工具）也照常跟，当存量的话之后只追加答复
 * 唤不醒、结局就丢了。shell 要最近 RECENT_MS 内写过、且没有持久化结局（unknown 的已由 resumeUnknownShells 接走）。
 * 留下的照样计入洪水闸：restart/resume 后 CC 一次性落盘几百个旧 subagent 时，它们的 mtime 也是新的。
 */
async function firstScanLive(agent: AgentLite, files: string[]): Promise<string[]> {
  const known = new Set(shellResults.snapshots(agent.name).map((r) => r.id));
  const live: string[] = [];
  for (const f of files) {
    const st = await stat(f).catch(() => null); // stat 失败 = 刚被删，当存量
    const shell = f.endsWith(".output");
    const active = !!st && (shell ? deps.now() - st.mtimeMs < RECENT_MS && !known.has(basename(f, ".output")) : !(await subagentFinished(f, st.mtimeMs)));
    if (active) live.push(f);
    else markStock(f, st?.size ?? 0);
  }
  return live;
}

/** 已有的 subagent 记录是不是已经收尾（交了答复 / 被停止 / 静默超限），静默时长按文件最后写入算 */
async function subagentFinished(f: string, mtimeMs: number): Promise<boolean> {
  const text = await Bun.file(f).text().catch(() => ""); // 读不到当没收尾：交给后面照常跟踪，读失败由 consume 处理
  return subagentEndStatus(foldProgress(text), readSubagentMeta(f), deps.now() - mtimeMs, SUBAGENT_SILENT_LIMIT_MS) !== null;
}

/** 当存量：不开流；subagent 另记休眠位置，续跑时按身份接回 */
function markStock(f: string, size: number): void {
  seen.add(f);
  if (f.endsWith(".jsonl")) dormantSubagents.set(f, size);
}

/** 休眠的 subagent 又长出 user 记录（SendMessage 续跑 / 工具结果回来）→ 从休眠位置接着跟；只多了别的记录就把位置往后挪 */
async function wakeDormantSubagents(agent: AgentLite, subFiles: string[]): Promise<void> {
  for (const f of subFiles) {
    const from = dormantSubagents.get(f);
    if (from === undefined) continue;
    const size = (await stat(f).catch(() => null))?.size ?? 0; // stat 失败 = 刚被删，size 0 不会进下面
    if (size <= from) continue;
    const bytes = await Bun.file(f).slice(from, size).arrayBuffer().catch(() => null); // 读失败：位置不动，下轮再看
    if (!bytes) continue;
    const buf = new Uint8Array(bytes);
    const used = buf.lastIndexOf(10) + 1;
    if (!hasUserRecord(new TextDecoder().decode(buf.subarray(0, used)))) {
      dormantSubagents.set(f, from + used);
      continue;
    }
    dormantSubagents.delete(f);
    await startActivity("subagent", agent, f, from).catch((e) => console.error(`🧵 subagent 续跑接回失败 (${agent.name}):`, (e as Error).message));
  }
}

/**
 * 会话轮转后 CC 把在跑 subagent 的后续写进新会话目录的同名 agent-<id>.jsonl：本 agent 还没收尾、来自别的会话的同 id 活动
 * 换绑过去接着读（先把旧文件读完），不开第二张卡，旧那份也不会因不再增长被收成「无动静」。防认错：新文件首条记录的 agentId
 * 必须是这个 id，且不早于旧文件最后一条（早于 = 整份拷贝，不是续写）。首行还没写完就扣下、下轮再认。
 * 返回本轮已处理（换绑 / 扣下）的文件，调用方不再当新文件 / 存量。
 */
async function rebindRotated(agent: AgentLite, subFiles: string[]): Promise<Set<string>> {
  const handled = new Set<string>();
  for (const f of subFiles) {
    const id = basename(f, ".jsonl");
    const act = seen.has(f) ? undefined : [...activities.values()].find(
      (a) => a.kind === "subagent" && !a.finished && a.agentName === agent.name && a.sessionId !== agent.sessionId && a.id === id,
    );
    if (!act) continue;
    const head = await readFirstRecord(f);
    if (!head) {
      handled.add(f); // 首行还没写完：这一轮既不当新卡也不当存量
      continue;
    }
    if (existsSync(act.filePath)) await consume(act).catch((e) => console.error(`🧵 subagent 旧文件读取失败 (${agent.name} ${id}):`, (e as Error).message));
    if (act.finished || head.agentId !== id.replace(/^agent-/, "") || Date.parse(String(head.timestamp)) < (act.progress.lastTs ?? -Infinity)) continue;
    console.log(`🧵 subagent 随会话轮转换绑: ${agent.name} ${id} ${act.sessionId} → ${agent.sessionId}`);
    activities.delete(act.key);
    Object.assign(act, { key: f, filePath: f, sessionId: agent.sessionId, offset: 0 });
    activities.set(f, act);
    seen.add(f);
    handled.add(f);
  }
  return handled;
}

/** 本 agent 要列的 shell 目录：当前会话的，加上 CC 在主会话 jsonl 里报过的（轮转后 shell 仍写旧会话的 tasks/），按当前目录的根拼回；
 *  ids = 同一批结构化启动结果里的任务 id（权威的真 bg 确认） */
async function shellDirsFor(agent: AgentLite): Promise<{ dirs: string[]; ids: Set<string> }> {
  const dir = deps.shellDir(agent.cwd, agent.sessionId);
  const root = dirname(dirname(dir));
  const r = await reportedDirs.scan(projectJsonlPath(agent.cwd, agent.sessionId), basename(root)).catch((e) => {
    console.error(`🧵 读主会话里的后台 shell 报告失败 (${agent.name}):`, (e as Error).message);
    return { sessions: [], ids: new Set<string>() };
  });
  return { dirs: [...new Set([dir, ...r.sessions.map((s) => join(root, s, "tasks"))])], ids: r.ids };
}

/** 确认超时跳过的 shell，id 后来出现在当前会话的结构化启动结果里 → 接回跟踪（不过洪水闸，同 reviveMissingShells） */
async function reviveLateConfirmed(agent: AgentLite, shellFiles: string[], ids: Set<string>): Promise<void> {
  for (const f of shellFiles) {
    if (!unconfirmedShells.has(f) || !ids.has(basename(f, ".output"))) continue;
    unconfirmedShells.delete(f);
    console.log(`🧵 bg shell 迟到确认（会话轮转后 registry 才跟上）: ${agent.name} ${basename(f)}`);
    const born = (await stat(f).catch(() => null))?.birthtimeMs; // 取不到建出时刻（stat 失败 / 文件系统不记）就按现在算
    await startActivity("shell", agent, f, 0, born && born <= deps.now() ? born : undefined).catch((e) => console.error(`🧵 bg shell 迟到确认后启动失败 (${agent.name}):`, (e as Error).message));
  }
}

/** 轮转前开始、还在跑的 shell 迁到当前会话：结局得记进当前会话的 scope，刷新快照和重启恢复都只读当前会话的（先记一条 unknown，
 *  bridge 中途死掉也能在当前会话里找回） */
async function rehomeShells(agent: AgentLite): Promise<void> {
  for (const act of [...activities.values()]) {
    if (act.kind !== "shell" || act.finished || act.agentName !== agent.name || act.sessionId === agent.sessionId) continue;
    act.sessionId = agent.sessionId;
    await shellResults.remember({ ...act, exitCode: null });
  }
}

/** 先接回消失后又出现的已确认 shell：startActivity 把它放回 seen，之后数新文件就不会把它算进洪水闸 */
async function reviveMissingShells(agent: AgentLite, shellFiles: string[]): Promise<void> {
  for (const f of shellFiles) {
    if (!missingShells.delete(f)) continue;
    // 同名 .output 换成了软链 = 后台 subagent 的对话记录（同 openFresh 的筛查），不是原 shell 的输出：不恢复，路径留在 seen 不再看
    if ((await lstat(f).catch(() => null))?.isSymbolicLink()) continue; // lstat 失败 = 又被删了，照常恢复，消失由宽限期处理
    await startActivity("shell", agent, f).catch((e) => console.error(`🧵 bg shell 恢复跟踪失败 (${agent.name}):`, (e as Error).message));
  }
}

/** 一个新出现的文件：shell 先过软链筛查与真 bg 确认，subagent 直接开流 */
async function openFresh(agent: AgentLite, f: string): Promise<void> {
  const kind: BgActivityKind = f.endsWith(".output") ? "shell" : "subagent";
  if (kind === "shell") {
    // 前台 Bash 的瞬时 .output 不开子区。后台 subagent 的 .output 是指向它对话记录的软链——当 shell 开会多出一张卡、
    // 满屏原始 JSON，它已经作为 subagent 在跟了
    if ((await lstat(f).catch(() => null))?.isSymbolicLink()) { // lstat 失败 = 文件刚被删，当普通文件走下面的确认
      seen.add(f);
      return;
    }
    if (!(await isRealBgTask(agent, basename(f).replace(/\.output$/, "")))) {
      const t0 = shellCandidates.get(f) ?? deps.now();
      shellCandidates.set(f, t0);
      if (deps.now() - t0 > SHELL_CONFIRM_TIMEOUT_MS) {
        seen.add(f); // 超时确认不了 = 前台瞬时文件，跳过；轮转后才确认的由 reviveLateConfirmed 接回
        unconfirmedShells.add(f);
        shellCandidates.delete(f);
      }
      return;
    }
    shellCandidates.delete(f);
  }
  await startActivity(kind, agent, f).catch((e) => console.error(`🧵 bg 活动启动失败 (${agent.name}):`, (e as Error).message));
}

/** 消费一个活动文件的新增字节，渲染进 queue */
async function consume(act: Activity): Promise<void> {
  let size = 0;
  try {
    size = (await stat(act.filePath)).size;
  } catch (e) {
    // 文件消失（session 清理）：subagent 照旧收尾；shell 没读到终止行就不知道进程是否结束 → 状态未知（不是成功）。
    // shell 的其它读失败（权限 / IO）不下结论（下轮再读），但要让前端知道已看不到它了
    if (act.kind === "shell") {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return setUnreadable(act, true);
      // 刚启动 / 刚有输出就不见：多半还没建出来或正被重建（磁盘满时实见），宽限期内只算没出现，免得一闪就判死
      if (deps.now() - act.lastGrowth < SHELL_MISSING_GRACE_MS) return;
      // 判了 unknown 之后文件若又出现，tick 按原身份重新跟一遍、按真实终止行更正结局；一直不出现就停在 unknown
      missingShells.add(act.filePath);
    }
    await finalize(act, act.kind === "shell" ? "unknown" : "idle", "文件已消失");
    return;
  }
  if (act.kind === "shell") return consumeShell(act, size);
  if (size <= act.offset) return;
  const buf = new Uint8Array(await Bun.file(act.filePath).slice(act.offset, size).arrayBuffer());
  // jsonl 只消费到最后一个换行（字节偏移）：CC 可能正写到半行，跳过它会丢掉恰好是收尾信号的那条记录
  const used = buf.lastIndexOf(10) + 1;
  const chunk = new TextDecoder().decode(buf.subarray(0, used));
  act.offset += used;
  if (used) act.lastGrowth = deps.now(); // 只剩同一段半行残尾不算增长，否则崩溃留下的残行会让静默计时永远归零

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    act.progress = nextProgress(act.progress, rec);
    if (rec.type !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b.name) {
        act.queue.push(`-# 🔧 ${formatTool(b.name, b.input)}`);
        act.eventCount++;
      } else if (b?.type === "text" && b.text?.trim()) {
        const t = b.text.trim();
        act.queue.push(`💬 ${t.length > MAX_TEXT_PER_ITEM ? t.slice(0, MAX_TEXT_PER_ITEM) + "…" : t}`);
        act.eventCount++;
      }
    }
  }
  scheduleFlush(act);
}

function scheduleFlush(act: Activity): void {
  if (act.queue.length && !act.flushTimer) {
    act.flushTimer = setTimeout(() => void flush(act), FLUSH_MS);
  }
}

/** shell：增量读字节，半行 / 多字节靠 ShellProgress 拼回；读到独立终止行记下结局（tick 里收尾）。
 *  本轮没增长且残尾恰是完整终止行（CC 没补换行）→ 也认 */
async function consumeShell(act: Activity, size: number): Promise<void> {
  if (size > act.offset) {
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await Bun.file(act.filePath).slice(act.offset, size).arrayBuffer());
    } catch {
      return setUnreadable(act, true); // 读失败不推进 offset、不下结论，只标「读不到」
    }
    setUnreadable(act, false);
    act.offset += buf.length;
    act.lastGrowth = deps.now();
    const r = feedShellChunk(act.shell, buf);
    act.queue.push(...r.lines);
    act.end = r.end;
  } else {
    // 没新字节时 stat 照样成功，「读得到」要单独确认，否则 chmod 000 的文件会被误报恢复
    setUnreadable(act, !(await access(act.filePath, fsConstants.R_OK).then(() => true, () => false)));
    if (act.unreadable) return;
    const tail = settleShellTail(act.shell);
    if (tail) {
      act.queue.push(tail.line);
      act.end = tail.end;
    }
  }
  scheduleFlush(act);
}

/** 「读不到」状态切换时立刻发一条空 items 的 update（只变化时发），进度里带 unreadable；快照走 progressView 同一字段 */
function setUnreadable(act: Activity, v: boolean): void {
  if (act.unreadable === v) return;
  act.unreadable = v;
  console.log(`🧵 bg shell 输出${v ? "读不到（状态未知，继续重试）" : "恢复可读"}: ${act.agentName} ${basename(act.filePath)}`);
  emitProgress(act);
}

/** 只带进度的空 update：前端据此切换「读不到」/ 把不再跟踪的卡拉回跟踪（stream-shape 对 shell 放行空 items + progress） */
function emitProgress(act: Activity): void {
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_update",
    data: { kind: act.kind, id: act.id, lines: 0, items: [], threadId: act.threadId, progress: progressView(act) },
  });
}

async function flush(act: Activity): Promise<void> {
  if (act.flushTimer) {
    clearTimeout(act.flushTimer);
    act.flushTimer = null;
  }
  if (!act.queue.length) return;
  const lines = act.queue.splice(0, act.queue.length);
  // 尾部环形缓冲（replay 用）
  act.recent.push(...lines);
  if (act.recent.length > RECENT_MAX) act.recent = act.recent.slice(-RECENT_MAX);
  // items 带上实际渲染行（每行已在 consume 里截断）——非 Discord 前端（web）据此
  // 还原子区内容；lines 保留计数供轻量消费者。内容通道，不追求完整性（源文件才是）。
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_update",
    data: { kind: act.kind, id: act.id, lines: lines.length, items: lines, threadId: act.threadId, progress: progressView(act) },
  });
  if (!act.threadId || !act.adapter) return;

  // shell 输出裹代码块；subagent 行本身已带 markdown 前缀
  let text = lines.join("\n");
  if (act.kind === "shell") text = "```\n" + text + "\n```";
  // 超长只保尾部（display 通道，最新进展 > 完整性；完整内容在源文件里）
  if (text.length > MAX_MSG_LEN) {
    text = (act.kind === "shell" ? "```\n…" : "…") + text.slice(-MAX_MSG_LEN + 40) + (act.kind === "shell" ? "" : "");
  }
  try {
    await act.adapter.send(act.threadId, { text });
  } catch (e) {
    console.error(`🧵 子区推送失败 (${act.agentName}):`, (e as Error).message);
  }
}

/** 卡片进度（web 渲染耗时 / 上下文 / 静默时长用）；shell 只有开始时刻与最后一次输出时刻（刷新后「已多久无输出」靠它），
 *  读不到输出时多带 unreadable */
function progressView(act: Activity) {
  const p = act.progress;
  if (act.kind === "subagent") return { startedTs: p.firstTs ?? act.startedAt, lastTs: p.lastTs, ctxTokens: p.ctxTokens, toolCount: p.toolCount };
  return { startedTs: act.startedAt, lastTs: act.lastGrowth, ...(act.unreadable ? { unreadable: true } : {}) };
}

/** 收尾状态：subagent 沿用 done / stopped / idle；shell 有 done（读到退出行，退出码另带）、stopped（读到 [killed]）、
 *  unknown（输出文件消失，不知结局） */
type FinalStatus = "done" | "stopped" | "idle" | "unknown";

/** endTs：已知的真实结束时刻（重启后才读到的终止行用文件最后写入时刻），不给就按现在 / subagent 的最后记录 */
async function finalize(act: Activity, status: FinalStatus = "idle", reason: string = status, endTs?: number): Promise<void> {
  if (act.finished) return;
  act.finished = true;
  await flush(act).catch(() => {});
  activities.delete(act.key);
  const t0 = act.progress.firstTs ?? act.startedAt;
  const durationMs = (endTs ?? (status === "done" ? (act.progress.lastTs ?? deps.now()) : deps.now())) - t0;
  const mins = (durationMs / 60_000).toFixed(1);
  const exitCode = act.end?.exitCode ?? null;
  console.log(`🧵 bg 活动结束: ${act.agentName} ${basename(act.filePath)}（${mins}min, ${reason}）`);
  recordMetric("bg_activity_completed", { agent: act.agentName, meta: { kind: act.kind } });
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_completed",
    data: { kind: act.kind, id: act.id, threadId: act.threadId, durationMs, status, ...(act.kind === "shell" ? { exitCode } : {}) },
  });
  if (act.kind === "shell") await shellResults.remember({ ...act, exitCode }, durationMs, act.end?.status ?? "unknown");
  if (act.threadId && act.adapter) {
    const head =
      act.kind === "subagent"
        ? `${{ done: "✅", stopped: "⏹", idle: "⏸", unknown: "❔" }[status]} subagent 结束`
        : act.end?.status === "stopped"
          ? "⏹ 后台任务已停止（被结束）"
          : exitCode === null
            ? "❔ 后台任务状态未知（输出文件已消失，无法确认是否结束）"
            : `${exitCode === 0 ? "✅" : "❌"} 后台任务已退出 · exit ${exitCode}`;
    try {
      await act.adapter.send(act.threadId, {
        text: `${head} · ${mins}min${act.eventCount ? ` · ${act.eventCount} 条动态` : ""}`,
      });
      await act.adapter.archiveThread?.(act.threadId);
    } catch { /* non-critical */ }
  }
}

// ── 主循环 ─────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) return; // 上一轮还没跑完（首轮 baseline 慢时尤其关键，否则存量文件被当新文件重播）
  ticking = true;
  try {
    await tickInner();
  } finally {
    ticking = false;
  }
}

/**
 * 「洪水闸」：baseline 只能标记扫描那一刻已存在的文件；restart/resume 后 CC 可能一次性把几百个**存量**
 * subagent 文件落盘，逐个当新任务开流会刷出几百张卡（git log -S BURST_LIMIT）。真工作流是陆续 spawn 的，
 * 所以单轮单 agent 新增超过阈值就按存量处理（标 seen 不开流）；门槛高于正常爆发（一次十几个 subagent 常见）。
 */
const BURST_LIMIT = 30;

async function tickInner(): Promise<void> {
  const agents = await deps.agents();

  for (const agent of agents) {
    // 该 agent-session 首次被扫到 → 只有「在跑」的已有文件开流，其余记存量（firstScanLive）
    const first = baseline.first(agent.name, agent.sessionId);
    await shellResults.select(agent.name, agent.sessionId);
    await rehomeShells(agent);
    const subFiles = await listFiles(subagentsDir(agent.cwd, agent.sessionId), ".jsonl");
    const reported = await shellDirsFor(agent);
    const newDirs = new Set(reported.dirs.filter((d) => !listedShellDirs.has(`${agent.name}\0${d}`)));
    for (const d of newDirs) listedShellDirs.add(`${agent.name}\0${d}`);
    const shellFiles = (await Promise.all(reported.dirs.map((d) => listFiles(d, ".output")))).flat();
    if (first) await resumeUnknownShells(agent, shellFiles); // 先于分拣：接着读的不能被当存量
    await reviveMissingShells(agent, shellFiles);
    await reviveLateConfirmed(agent, shellFiles, reported.ids);
    const rebound = await rebindRotated(agent, subFiles); // 先于休眠接回 / 分拣：续写到新会话目录的不是新任务也不是存量
    await wakeDormantSubagents(agent, subFiles);
    // 单轮新增文件计数（洪水闸用）：本轮未见过的新文件，首轮（含新认出的 shell 目录）只数「在跑」的
    const unseen = [...subFiles, ...shellFiles].filter((f) => !seen.has(f) && !rebound.has(f));
    const sortFirst = (f: string) => first || newDirs.has(dirname(f));
    const fresh = [...unseen.filter((f) => !sortFirst(f)), ...(await firstScanLive(agent, unseen.filter(sortFirst)))];
    if (fresh.length > BURST_LIMIT) {
      for (const f of fresh) markStock(f, (await stat(f).catch(() => null))?.size ?? 0); // stat 失败 = 刚被删，位置记 0
      console.log(
        `🧵 bg 洪水抑制: ${agent.name} 本轮新增 ${fresh.length} 个文件（>${BURST_LIMIT}）——` +
          `按存量处理，不开流（多半是 restart/resume 后一次性落盘的旧 subagent）`,
      );
      continue;
    }
    for (const f of fresh) await openFresh(agent, f);
  }

  // 候选清理：文件已消失（前台命令结束即删）的 candidate 不再保留
  for (const f of [...shellCandidates.keys()]) {
    if (!existsSync(f)) shellCandidates.delete(f);
  }

  // 消费 + 结束判定
  for (const act of [...activities.values()]) {
    await consume(act).catch(() => {});
    if (act.finished) continue;
    if (act.kind === "shell") {
      // 只认终止行；静默多久都保持跟踪（不按时间收尾）
      if (act.end) await finalize(act, act.end.status, act.end.status === "done" ? `exit ${act.end.exitCode}` : "killed").catch(() => {});
      continue;
    }
    const silentMs = deps.now() - act.lastGrowth;
    act.meta = metaFor(act); // 停止是事后写进 meta 的
    const meta = act.staleStop ? { ...act.meta, stoppedByUser: false } : act.meta;
    const end = subagentEndStatus(act.progress, meta, silentMs, SUBAGENT_SILENT_LIMIT_MS);
    if (!end) continue;
    await finalize(act, end).catch(() => {});
    dormantSubagents.set(act.filePath, act.offset); // 收尾后又被 SendMessage 续跑：从这里接回（wakeDormantSubagents）
  }

  // seen 集合瘦身（约每小时一次）：源文件已被清理的条目不会再出现，安全移除
  if (++tickCount % 360 === 0) {
    for (const f of seen) if (!existsSync(f)) seen.delete(f);
    for (const f of missingShells) if (!existsSync(dirname(f))) missingShells.delete(f);
    for (const f of dormantSubagents.keys()) if (!existsSync(f)) dormantSubagents.delete(f);
    for (const f of unconfirmedShells) if (!existsSync(f)) unconfirmedShells.delete(f);
    for (const k of listedShellDirs) if (!existsSync(k.slice(k.indexOf("\0") + 1))) listedShellDirs.delete(k);
    reportedDirs.retain(agents.map((a) => projectJsonlPath(a.cwd, a.sessionId)));
    // baseline key 同步瘦身:按 registry 在册 agent 名过滤(不按 session,见 BaselineKeys.prune)
    try {
      baseline.prune((await readActiveAgents()).map((a) => a.name));
    } catch { /* registry 读失败:下小时再试 */ }
  }
}

/**
 * 「最后一个**人类**是从哪儿跟这个 agent 说话的」，由 bridge 注入。必须是人类来源：最后一条消息的来源会被
 * agent→agent 转发 / peer pushback / nudge 刷成 "agent"，纯 Web 会话也会被建 Discord 子区。
 * undefined = 没有人类交互记录 → 按 Discord 处理（保守）。
 */
export type SourceProvider = (channelId: string) => "user" | "api" | undefined;
let sourceProvider: SourceProvider | null = null;

export function startBgActivityWatcher(opts?: { sourceProvider?: SourceProvider }): void {
  sourceProvider = opts?.sourceProvider ?? null;
  setInterval(() => void tick().catch(() => {}), POLL_MS);
  void tick().catch(() => {}); // 立即 baseline，避免启动后第一批新文件被当存量
  console.log(`🧵 bg 活动追踪启动（每 ${POLL_MS / 1000}s 扫 subagents + bg shell tasks）`);
}

/** 测试/诊断：当前活跃活动数 */
export function activeBgActivities(): number {
  return activities.size;
}

/** web 连流后的 replay：某 agent 当前活跃（未 finalize）的 bg 任务快照，外加近期已收尾的 shell（带 end）。
 *  lines = 已 flush 的尾部行（≤RECENT_MAX）;刷新后前端据此重建面板。 */
type BgTaskSnapshot = { id: string; kind: BgActivityKind; title: string; startedAt: number; lines: string[] } & Record<string, unknown>;

const shellResults = new ShellResults();

export function activeBgTasksFor(agentName: string): BgTaskSnapshot[] {
  const liveIds = new Set([...activities.values()].filter((a) => a.agentName === agentName).map((a) => a.id));
  const out: BgTaskSnapshot[] = shellResults.snapshots(agentName).filter((s) => !liveIds.has(s.id));
  for (const act of activities.values()) {
    if (act.agentName !== agentName || act.finished) continue;
    if (act.kind === "subagent" && !act.meta.description) act.meta = metaFor(act); // 起活动时 meta 可能还没落盘：快照补读，协作视图按 description 挂审查员
    const title = act.meta.description ? `🤖 ${act.meta.description}` : titleFor(act.kind, act.filePath);
    out.push({ id: act.id, kind: act.kind, title, startedAt: act.startedAt, lines: [...act.recent], agentType: act.meta.agentType, model: act.meta.model, progress: progressView(act) });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

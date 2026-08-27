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
 * 结束判定（v1 务实策略）：文件连续 IDLE_DONE_MS 不增长 → 视为结束。subagent
 * 没有权威的"完成"落盘标记，等主 session 的 tool_result 匹配过于耦合；display
 * 通道晚归档几分钟无伤大雅。
 *
 * 重启防重放：启动后第一轮 poll 只记 baseline（已存在的文件全部标记 seen 不开流），
 * 之后只对新出现的文件开活动 —— bridge 重启不会把历史 subagent 全部重播一遍。
 */

import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { projectsSlug, projectJsonlPath } from "../lib/jsonl-cost.js";
import { readActiveAgents } from "../lib/registry.js";
import { adapterFor, type ChatAdapter } from "./adapters.js";
import { parseChatId } from "./router.js";
import { emitEvent } from "./event-bus.js";
import { formatTool } from "./jsonl-watcher.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_MS = 10_000;
const FLUSH_MS = 2_500; // 子区推送 debounce（Discord 限速友好）
const IDLE_DONE_MS = 3 * 60_000; // 文件 3min 不增长 → 活动结束
const MAX_MSG_LEN = 1900;
const MAX_ACTIVE_PER_AGENT = 8; // 防 thread 轰炸（workflow 大扇出时超出的只发事件）
const MAX_TEXT_PER_ITEM = 400; // subagent 单条文本进子区的截断长度

export type BgActivityKind = "subagent" | "shell";

interface Activity {
  key: string; // 全局唯一（文件路径）
  /** 对外稳定 id（文件 basename 去后缀：subagent = "agent-xxx"，shell = taskId）——
   *  SSE 事件用它做关联键，不外泄服务器绝对路径 */
  id: string;
  kind: BgActivityKind;
  agentName: string;
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
const SHELL_CONFIRM_TIMEOUT_MS = 60_000;
let baselined = false;
let ticking = false; // tick 重入保护：首轮 baseline 超过 POLL_MS 时 interval 会并发进入
let tickCount = 0;

// ── 目录定位 ───────────────────────────────────────────────────────────

function subagentsDirFor(cwd: string, sessionId: string): string {
  return join(
    process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd), sessionId, "subagents",
  );
}

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

async function startActivity(
  kind: BgActivityKind,
  agent: AgentLite,
  filePath: string,
): Promise<void> {
  seen.add(filePath);
  const title = titleFor(kind, filePath);
  const { transport } = parseChatId(agent.channelId);
  const adapter = adapterFor(transport);

  // v2.14+ 按来源分流：上一回合是从 Web/API 来的，就**不要**在 Discord 建子区。
  // 此前无条件建，而 agent.channelId 永远是 Discord 频道 —— 于是纯 Web 用户每起
  // 一个 subagent / 后台命令就被推送一条 Discord 线程通知（owner 2026-07-25 报：
  // 「之前不是说了把 Web 端跟 Discord 端分开吗」）。Web 侧本来就有 bg_task_* SSE
  // 事件渲染同样的进度，子区对它是纯粹的噪音。
  // 不确定来源时（undefined）保持建子区的老行为，宁可多一条通知也不丢可观测性。
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

  const act: Activity = {
    key: filePath,
    id: basename(filePath).replace(/\.(jsonl|output)$/, ""),
    kind,
    agentName: agent.name,
    ownerChatId: agent.channelId,
    filePath,
    threadId,
    adapter,
    offset: 0,
    lastGrowth: Date.now(),
    startedAt: Date.now(),
    queue: [],
    flushTimer: null,
    eventCount: 0,
    finished: false,
    recent: [],
  };
  activities.set(filePath, act);
  console.log(
    `🧵 bg 活动开始: ${agent.name} ${title}` +
      (threadId ? ` → thread ${threadId}` : wantThread ? "（无子区，仅事件）" : "（Web 回合，只发事件不建子区）"),
  );
  recordMetric("bg_activity_started", { agent: agent.name, meta: { kind } });
  emitEvent({
    agent: agent.name,
    chatId: agent.channelId,
    type: "bg_task_started",
    data: { kind, id: act.id, threadId, title },
  });
}

/** 消费一个活动文件的新增字节，渲染进 queue */
async function consume(act: Activity): Promise<void> {
  let size = 0;
  try {
    size = (await stat(act.filePath)).size;
  } catch {
    // 文件消失（session 清理）→ 直接收尾
    await finalize(act, "文件已消失");
    return;
  }
  if (size <= act.offset) return;
  const chunk = await Bun.file(act.filePath).slice(act.offset, size).text();
  act.offset = size;
  act.lastGrowth = Date.now();

  if (act.kind === "shell") {
    for (const line of chunk.split("\n")) {
      if (line.trim()) act.queue.push(line.slice(0, 300));
    }
  } else {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
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
  }
  if (act.queue.length && !act.flushTimer) {
    act.flushTimer = setTimeout(() => void flush(act), FLUSH_MS);
  }
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
    data: { kind: act.kind, id: act.id, lines: lines.length, items: lines, threadId: act.threadId },
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

async function finalize(act: Activity, reason = "结束"): Promise<void> {
  if (act.finished) return;
  act.finished = true;
  await flush(act).catch(() => {});
  activities.delete(act.key);
  const mins = ((Date.now() - act.startedAt) / 60_000).toFixed(1);
  console.log(`🧵 bg 活动结束: ${act.agentName} ${basename(act.filePath)}（${mins}min, ${reason}）`);
  recordMetric("bg_activity_completed", { agent: act.agentName, meta: { kind: act.kind } });
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_completed",
    data: { kind: act.kind, id: act.id, threadId: act.threadId, durationMs: Date.now() - act.startedAt },
  });
  if (act.threadId && act.adapter) {
    try {
      await act.adapter.send(act.threadId, {
        text: `✅ ${act.kind === "subagent" ? "subagent 结束" : "后台任务结束"} · ${mins}min${act.eventCount ? ` · ${act.eventCount} 条动态` : ""}`,
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

async function tickInner(): Promise<void> {
  const agents = await watchableAgents();
  const first = !baselined;
  baselined = true;

  for (const agent of agents) {
    const subFiles = await listFiles(subagentsDirFor(agent.cwd, agent.sessionId), ".jsonl");
    const shellFiles = await listFiles(shellTasksDirFor(agent.cwd, agent.sessionId), ".output");
    for (const [kind, files] of [["subagent", subFiles], ["shell", shellFiles]] as const) {
      for (const f of files) {
        if (seen.has(f)) continue;
        if (first) {
          seen.add(f); // baseline：存量文件不重播
          continue;
        }
        // shell：先确认是真 bg 任务（前台 Bash 的瞬时 .output 不开子区）
        if (kind === "shell") {
          const taskId = basename(f).replace(/\.output$/, "");
          if (!(await isRealBgTask(agent, taskId))) {
            const t0 = shellCandidates.get(f) ?? Date.now();
            shellCandidates.set(f, t0);
            if (Date.now() - t0 > SHELL_CONFIRM_TIMEOUT_MS) {
              seen.add(f); // 超时确认不了 = 前台瞬时文件，永久跳过
              shellCandidates.delete(f);
            }
            continue;
          }
          shellCandidates.delete(f);
        }
        await startActivity(kind, agent, f).catch((e) =>
          console.error(`🧵 bg 活动启动失败 (${agent.name}):`, (e as Error).message),
        );
      }
    }
  }

  // 候选清理：文件已消失（前台命令结束即删）的 candidate 不再保留
  for (const f of [...shellCandidates.keys()]) {
    if (!existsSync(f)) shellCandidates.delete(f);
  }

  // 消费 + 结束判定
  for (const act of [...activities.values()]) {
    await consume(act).catch(() => {});
    if (!act.finished && Date.now() - act.lastGrowth > IDLE_DONE_MS) {
      await finalize(act).catch(() => {});
    }
  }

  // seen 集合瘦身（约每小时一次）：源文件已被清理的条目不会再出现，安全移除
  if (++tickCount % 360 === 0) {
    for (const f of seen) if (!existsSync(f)) seen.delete(f);
  }
}

/**
 * 「最后一个**人类**是从哪儿跟这个 agent 说话的」，由 bridge 注入。
 *
 * 必须是「人类来源」而不是「最后一条消息的来源」：后者会被 agent→agent 转发、
 * peer pushback、看门狗 nudge 刷成 "agent"，用它判断会失准（2026-07-25 实测，
 * 纯 Web 会话的值是 "agent"，子区照样建到了 Discord）。
 * 返回 undefined = 没有人类交互记录 → 按 Discord 处理（保守，保持老行为）。
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

/** web 连流后的 replay：某 agent 当前活跃（未 finalize）的 bg 任务快照。
 *  lines = 已 flush 的尾部行（≤RECENT_MAX）;刷新后前端据此重建面板。 */
export function activeBgTasksFor(agentName: string): Array<{
  id: string;
  kind: BgActivityKind;
  title: string;
  startedAt: number;
  lines: string[];
}> {
  const out: Array<{ id: string; kind: BgActivityKind; title: string; startedAt: number; lines: string[] }> = [];
  for (const act of activities.values()) {
    if (act.agentName !== agentName || act.finished) continue;
    out.push({
      id: act.id,
      kind: act.kind,
      title: titleFor(act.kind, act.filePath),
      startedAt: act.startedAt,
      lines: [...act.recent],
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

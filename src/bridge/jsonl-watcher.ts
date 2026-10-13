/** Claude Code / Pi 的 JSONL 尾读与 ACP 推送共用流事件处理。 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import { WATCHER_CONFIG, MCP_TOOL_PREFIX } from "./config.js";
import { discordReply } from "./discord-api.js";
import { projectJsonlPath } from "../lib/jsonl-cost.js";
import { findSessionJsonlBySessionId, translateSessionLine } from "../lib/session-source.js";
import { resolveSessionPath } from "../lib/session-path-resolve.js";
import { isAcpChannel } from "./acp-state.js";
import { tmuxCapture, windowTarget } from "../lib/tmux-helper.js";
import { parseAuqPane } from "../lib/auq-pane.js";
import { progressNoteOf } from "../lib/session-history.js";
import { readCursor, resetReadState, tailReadCursor, type ReadCursor } from "../lib/jsonl-read-cursor.js";
import { transcriptUserEvent } from "../lib/turn-cuts.js";
// v2.6.0+ 旁路事件埋点（设计 D1：只 emit 不改渲染管线）
import { emitEvent, getAgentStatus, isPostTurnActivity } from "./event-bus.js";
import { isLimitHitText } from "../lib/quota-wall-text.js";
import { installAcpPushWatcher } from "./acp-watcher-generation.js";
import { InstallGenerations, type OwnerRef } from "./watcher-ownership-gen.js";
import { auqEchoCard } from "../lib/auq-echo.js";
import { formatTool, formatToolDetail } from "../lib/tool-display-format.js";

interface ToolEntry { id: string; summary: string; done: boolean; error: boolean }

interface WatcherState {
  watcher: FSWatcher;
  jsonlPath: string;
  cursor?: ReadCursor;
  translationScope?: object;
  /** v2.23.2+ 会话 id：直播事件带 sid，前端只拿同一会话的历史游标比 seq */
  sessionId: string;
  /** Next physical line number, shared with history (blank lines count). */
  lineNo: number;
  channelId: string;
  tools: ToolEntry[];
  toolMsgId: string | null;
  textQueue: string[];
  /** 还没发出去的 textQueue 里算「答复」的文字（Stop 兜底转发用）：API 错误条目的文字不在里面 */
  answerParts: string[];
  textTimer: ReturnType<typeof setTimeout> | null;
  agentName: string;
  /** v2.23+ 运行时：决定行怎么翻译（Pi 的行形状与 Claude Code 不同） */
  runtime?: string;
  /** 并发锁：processNewData 同时只能跑一份 */
  processing: boolean;
  /** 2s poll 兜底的 interval handle */
  pollInterval: ReturnType<typeof setInterval> | null;
  /** 本轮命中额度墙（"You've hit your … limit"）：下一条 turn_duration 是被拒的等待时长，不显示；读到它时复位 */
  rateLimited: boolean;
  /** 最后一条 assistant 条目是 API 错误（额度 / 网络…）：error 字段 + 原文；Stop 时 drain 兜底据此不把错误文字当答复（bridge/stop-settle.ts） */
  apiErrorTurn?: { error: string; text: string } | false;
  /** 最后一条 assistant 条目的行号：同一轮的 Stop 重复到达时，它没变（bridge/stop-settle.ts markRepeat） */
  lastAssistantSeq?: number;
  /** ACP 宿主的频道（bridge/acp-state.ts）：条目由宿主推来（pushEntries），不读文件、没有 fs.watch / 轮询 */
  push?: true;
  /** 已停下的尾读 watcher：在途的那一拍读完也不再发正文 / 事件（旧会话的字不能漏进新代） */
  retired?: true;
}

const watchers = new Map<string, WatcherState>();
const parkedPush = new Map<string, WatcherState>(); // 停下的 ACP 推送 watcher（startPushWatcher 同一会话沿用）

const HIDDEN_TOOLS = new Set([
  "reply", "react", "edit_message", "fetch_messages", "download_attachment",
]);

function isHiddenTool(name: string): boolean {
  if (HIDDEN_TOOLS.has(name)) return true;
  // 只隐藏 Discord 通信相关的 MCP 工具
  if (name.startsWith(MCP_TOOL_PREFIX)) return true;
  if (name.startsWith("mcp__plugin_discord_discord__")) return true;
  return false;
}

// v2.8+ 导出：bg-activity-watcher 渲染 subagent 的工具调用时复用同一套格式（实现在 lib/tool-display-format.ts，此处 re-export 保持原导出名）
export { formatTool, formatToolDetail };

/** 渲染 tool 列表为 Discord 消息 */
function renderToolMsg(tools: ToolEntry[]): string {
  return tools.map((t) => {
    const icon = t.done ? (t.error ? "❌" : "✅") : "⏳";
    return `-# ${icon} ${t.summary}`;
  }).join("\n");
}

/** 发送或编辑 tool 消息 */
/**
 * M6：web-only 模式下会话地址是 `local-<uuid>` 合成 id，Discord client 未登录，
 * 对它 `discord.channels.fetch` 必然 reject（虽被各 send 的 try/catch 吞掉，但每 tick
 * 空跑一次无意义的 fetch）。web 前端的实时内容走 event-bus SSE，与这些 Discord 发送
 * 无关——命中 local 频道直接短路。
 */
function isLocalChannel(channelId: string): boolean {
  return channelId.startsWith("local-");
}

async function syncToolMsg(state: WatcherState, discord: Client) {
  if (state.tools.length === 0) return;
  if (isLocalChannel(state.channelId)) return;
  const content = renderToolMsg(state.tools);

  try {
    const ch = await discord.channels.fetch(state.channelId) as TextChannel;
    if (state.toolMsgId) {
      // edit 已有消息
      const msg = await ch.messages.fetch(state.toolMsgId);
      await msg.edit(content);
    } else {
      // 发新消息
      const msg = await ch.send(content);
      state.toolMsgId = msg.id;
    }
  } catch { /* non-critical */ }
}

/** 发 Claude 的文本。
 *  每条文本前缀 `-# `（Discord 的 subtext 样式）。原先手动 buf 拼接在**单条**
 *  item 超 Discord 2000 char 限制的时候直接塞进 buf 一发就 400，silent catch
 *  吞错误用户什么都看不到。改用 discordReply 自带的 chunkText，按行切 + 补 2000
 *  上限自动分段，再加 trackSentMessage 跟原逻辑一致。 */
async function flushText(state: WatcherState, discord: Client) {
  if (state.textQueue.length === 0) return;
  if (isLocalChannel(state.channelId) || state.retired) { state.textQueue.length = state.answerParts.length = 0; return; }
  const items = state.textQueue.splice(0);
  state.answerParts.length = 0;
  const body = items.map((item) => `-# ${item}`).join("\n");
  try {
    await discordReply(discord, state.channelId, body);
  } catch { /* non-critical */ }
  state.toolMsgId = null;
  state.tools = state.tools.filter(t => !t.done);
}

/**
 * v2.4.17+ 检测当前 turn 末尾是不是 agent 在用 ScheduleWakeup 安排后续唤醒。
 *
 * Claude Code 较新版本 agents 倾向把任务包成 Bash{run_in_background:true} +
 * ScheduleWakeup 安排几分钟后回来 poll。这时 turn 干净结束，Stop hook 会 fire，
 * 但其实"用户任务"没真做完 —— 只是在排队等下一次回调。如果走完普通完成通知就
 * 会 @ 用户 "✅ 完成"，用户误以为对话结束。
 *
 * 实现：往回扫 jsonl 最多 30 个 assistant 条目，找 tool_use.name==='ScheduleWakeup'。
 * 遇到 type==='user' 的"真用户消息"（非 tool_result-only）就停 —— 那是新一轮的
 * 起点，老 ScheduleWakeup 不再相关。返回 true 表示"agent 在排队，**不要**报完成"。
 */
export async function hasRecentScheduleWakeup(
  cwd: string, sessionId: string,
): Promise<boolean> {
  try {
    // 只读文件尾部。原来是整文件 .text() —— 注释写着"上限避免大文件 IO"，但那个
    // 上限只限制了**解析**行数，读取本身仍然把整个文件拉进内存：本机最大的 session
    // jsonl 已经 96MB，而这里只需要最后 60 行。每个回合都这么来一次。
    // 512KB 尾巴足够覆盖 60 行（单行再长也很少超过几 KB）。
    const jsonlPath = projectJsonlPath(cwd, sessionId);
    const TAIL_BYTES = 512 * 1024;
    const f = Bun.file(jsonlPath);
    const size = f.size;
    const text = await (size > TAIL_BYTES ? f.slice(size - TAIL_BYTES).text() : f.text());
    const lines = text.split("\n");
    // 反向扫，上限避免分析全文件
    const SCAN_LIMIT = 60;
    let scanned = 0;
    for (let i = lines.length - 1; i >= 0 && scanned < SCAN_LIMIT; i--) {
      const line = lines[i];
      if (!line) continue;
      scanned++;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type === "user") {
        const c = d.message?.content;
        // tool_result-only 的"user"条目不算真用户消息（它只是 Claude 自循环）
        const isRealUserMsg =
          typeof c === "string" ||
          (Array.isArray(c) && c.some((x: any) => x?.type === "text"));
        if (isRealUserMsg) return false;
        continue;
      }
      if (d.type === "assistant") {
        const content = d.message?.content || [];
        for (const item of content) {
          if (item?.type === "tool_use" && item?.name === "ScheduleWakeup") return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// v2.2.0+: auto-deny 通知去重。一次 deny 可能只产生一条 tool_result，但 agent 之后
// 又试别的被拦操作会再产生 → 15s 窗口内每个 channel 只弹一次「临时放行」按钮。
const lastAutoDenyPost = new Map<string, number>();
async function maybePostAutoDeny(discord: Client, state: WatcherState, reason: string) {
  if (isLocalChannel(state.channelId)) return;
  const now = Date.now();
  if (now - (lastAutoDenyPost.get(state.channelId) || 0) < 15_000) return;
  lastAutoDenyPost.set(state.channelId, now);
  try {
    const text = [
      `🚫 **${state.agentName}** 一个操作被 auto 模式拦下了`,
      reason ? `原因：${reason}` : "",
      `如果这确实是你要做的，点下面临时放行（切 bypass）并让它重试。`,
    ].filter(Boolean).join("\n");
    // 直接传 **raw** components 给 discordReply，它内部自己 buildComponents 一次。
    // v2.2.0~v2.3.2 这里曾自己 buildComponents 一次再传给 discordReply → 双重 build：
    // discordReply 第二次拿到的是 ActionRowBuilder（不是 raw {type:"buttons"...}），
    // buildComponents 两个分支都不命中 → 返回空数组 → 按钮没附上去。owner 在 alipan
    // 频道实测：两条 deny 文字都到了，但 `GET /channels/.../messages/<id>` 返回的
    // `components` 为 `[]`，确认双重 build 吃掉了按钮。
    await discordReply(discord, state.channelId, text, undefined, [
      {
        type: "buttons",
        buttons: [
          { id: `auto_allow:${state.channelId}`, label: "临时放行并重试", emoji: "⚡", style: "primary" },
        ],
      },
    ]);
    console.log(`🚫 auto-deny 通知 agent=${state.agentName} reason="${reason.slice(0, 60)}"`);
  } catch (e) {
    console.error("auto-deny 通知失败:", e);
  }
}

/**
 * 处理 jsonl 新增数据：读新字节、解析 entry、推 tool/text 到队列。
 * 并发时以 state.processing 作锁，**且后到的调用必须等前一次跑完**（而不是 bail）—
 * 见下面 v2.0.18 注释。hoist 到模块级，Stop hook 也能直接调来"强制吃完 jsonl 再
 * flush"（见 drainChannelWatcher）。
 */
/** Relocated files keep the cursor when the new file still ends the anchored line at offset (see readCursor); otherwise it is a new generation. */
async function followMovedSession(state: WatcherState, discord: Client) {
  if (watchers.get(state.agentName) !== state) return null; // 已经 stopWatching 了（在途的最后一拍）：再 watch 新家就漏一个关不掉的 watcher
  const moved = findSessionJsonlBySessionId(state.runtime, state.sessionId);
  if (!moved || moved === state.jsonlPath) return null;
  console.log(`🚚 会话文件搬家了（进了 worktree）: ${state.agentName} → ${moved}`);
  state.watcher.close();
  state.jsonlPath = moved;
  state.watcher = watch(moved, (eventType) => { if (eventType === "change") processNewData(state, discord); });
  return stat(moved);
}

type Item = { seq: number; line?: string; entry?: any };

/** 文件里新写的行；推送模式不读文件（rollout 仍有人写，但直播只认宿主推来的，免得两份） */
async function newLines(state: WatcherState, discord: Client): Promise<Item[] | null> {
  if (state.push) return null;
  const present = await stat(state.jsonlPath).catch(() => followMovedSession(state, discord)); // A missing path may have moved.
  if (!present) return null;
  const chunk = await readCursor(state.jsonlPath, state.cursor!);
  if (chunk.reset) { await flushText(state, discord); resetReadState(state); state.translationScope = {}; }
  state.lineNo = state.cursor!.lineNo;
  return chunk.lines;
}

async function processNewData(state: WatcherState, discord: Client, pushed?: object[]): Promise<{ ok: boolean; lost: number }> {
  // Stop must wait for an in-flight read before flushing, or its answer queue may still be empty.
  // Bound the wait so an IO failure cannot indefinitely hold a Stop hook.
  const lockWaitStart = Date.now(); let lost = 0;
  while (state.processing) {
    if (Date.now() - lockWaitStart > 5000) {
      console.error(`⚠️ processNewData 等锁超过 5s 放弃，agent=${state.agentName}`);
      return { ok: false, lost: 0 };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  state.processing = true;
  try {
    // 宿主推来的条目 seq 用本地序号：sid 带 acp: 前缀，前端不拿它比 rollout 的历史游标，走时间戳规则
    const items = pushed ? pushed.map((entry) => ({ seq: state.lineNo++, entry })) : await newLines(state, discord);
    if (!items || state.retired) return { ok: true, lost: 0 };
    let toolsChanged = false;
    for (const { seq, line, entry: given } of items as Item[]) {
      if (state.retired) break; // 条目间有 await（AUQ 抓屏）：中途被停就不再发
      try {
        // Pi / Codex 的行在这里翻译成 Claude Code 形状；ACP 宿主推来的已是这个形状，下面共用解析逻辑
        if (!given) JSON.parse(line!); // Diagnose malformed complete lines even when a runtime translator ignores them.
        const entry = given ?? translateSessionLine(state.runtime, line!, state.translationScope ?? state);
        if (!entry) continue;

        // v2.2.0+: auto-mode classifier 拦截检测。被拦的操作在 jsonl 里是一条
        // type:"user" 的 tool_result（is_error），内容稳定含 "denied by the Claude
        // Code auto mode classifier. Reason: …"。检测到 → 频道弹「临时放行」按钮。
        //
        // v2.5.5+: 必须查 is_error === true。之前只做字符串正则 → agent 一 Read/
        // grep 到**含这行字面量的源码**（比如本文件自己），tool_result 里带着这
        // 句话就误报"被 auto 拦了"，明明 agent 全程 bypass 也弹放行按钮（owner
        // 2026-07-09 实测：claudestra agent 读 jsonl-watcher.ts 触发）。真 deny
        // 的 tool_result 一定 is_error，成功的 Read/Bash 结果不会。
        if (entry.type === "user") {
          const uc = entry.message?.content;
          if (Array.isArray(uc)) {
            for (const b of uc) {
              if (
                b?.type === "tool_result" &&
                b.is_error === true &&
                typeof b.content === "string" &&
                /denied by the Claude Code auto mode classifier/i.test(b.content)
              ) {
                const rm = b.content.match(/Reason:\s*([\s\S]+?)(?:\.\s+If you|\.\.|$)/i);
                const reason = rm ? rm[1].trim().replace(/\s+/g, " ").slice(0, 220) : "";
                maybePostAutoDeny(discord, state, reason).catch(() => {});
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "auto_deny", data: { reason } });
              }
            }
          }
        }

        // 显示思考时长（仅展示，不用于完成判断）
        if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
          if (state.rateLimited) {
            // rate-limit 的 turn_duration 不是真的在思考，是 API 拒绝的等待时长。
            // 跟 "⛔ limit" 消息一起显刷屏，跳过 + reset flag。
            state.rateLimited = false;
          } else {
            const secs = (entry.durationMs / 1000).toFixed(0);
            state.textQueue.push(`⏱ 尼了 ${secs} 秒`);
            emitEvent({ agent: state.agentName, chatId: state.channelId, type: "turn_duration", data: { durationMs: entry.durationMs } });
          }
        }

        // compact 完成通知：compact 结束时 CC 在 jsonl 落一条 system/compact_boundary
        // （compactMetadata 带 pre/postTokens）。此前「压缩完没完」只能用户亲自去
        // 验证（owner 2026-07-14）——这里把它变成一等事件：频道推完成消息 +
        // SSE compact_done（web 端插分隔线、ctx 徽章即时回落）。
        // v2.21.2+ 手动 compact 的开始标记:注入/排队的 `/compact` 出队时 CC 落一条裸
        // "/compact" user 记录(Robinhood 2026-09-02:12:39:27 落盘 → 12:41:25 boundary,
        // 117s 里 UI 一直「已完成」)。2s poll 比 permission-watcher 的 8s pane 检测快,
        // 先点亮;同样只认 30s 内的新鲜记录(重启回放 / 迟读不误点)。
        if (entry.type === "user" && typeof entry.message?.content === "string" && entry.message.content.trim() === "/compact") {
          const cmdTs = Date.parse(entry.timestamp || "");
          if (Number.isFinite(cmdTs) && Date.now() - cmdTs < 30_000 && getAgentStatus(state.agentName) !== "compacting") {
            state.textQueue.push("📦 正在压缩上下文…");
            emitEvent({ agent: state.agentName, chatId: state.channelId, type: "agent_status", data: { status: "compacting", trigger: "jsonl_cmd" } });
          }
        }

        if (entry.type === "system" && entry.subtype === "compact_boundary") {
          const cm = entry.compactMetadata || {};
          const pre = typeof cm.preTokens === "number" ? cm.preTokens : 0;
          const post = typeof cm.postTokens === "number" ? cm.postTokens : 0;
          const fmtK = (n: number) => `${Math.round(n / 1000)}k`;
          state.textQueue.push(pre ? `📦 上下文已压缩：${fmtK(pre)} → ${fmtK(post)}` : "📦 上下文已压缩");
          emitEvent({
            agent: state.agentName,
            chatId: state.channelId,
            type: "compact_done",
            data: { preTokens: pre, postTokens: post, trigger: cm.trigger },
          });
          // v2.21.2+ 压缩结束 → 回合态收敛。手动 compact 在 Stop 之后触发,结束即空闲
          // → done;自动 compact 发生在回合中途,结束后 CC 继续本回合 → thinking。
          // 只在状态确为 compacting 时动,不覆盖别的状态。
          if (getAgentStatus(state.agentName) === "compacting") {
            emitEvent({
              agent: state.agentName,
              chatId: state.channelId,
              type: "agent_status",
              data: { status: cm.trigger === "auto" ? "thinking" : "done", trigger: "compact_done" },
            });
          }
        }

        if (entry.type === "assistant") {
          state.lastAssistantSeq = seq;
          // 回合被 API 错误终止（assistant 条目 + isApiErrorMessage，紧跟 turn_duration）→ bridge 续跑 / 额度闸（text 给闸认撞墙原文）
          state.apiErrorTurn = entry.isApiErrorMessage === true && { error: String(entry.error ?? ""), text: String(entry.message?.content?.[0]?.text ?? "").slice(0, 300) };
          if (state.apiErrorTurn) emitEvent({ agent: state.agentName, chatId: state.channelId, type: "api_error_turn", data: { ...state.apiErrorTurn, ts: entry.timestamp ?? null } });
          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;

          // v2.0.19+: AskUserQuestion (Claude Code 内建) 弹多选 modal —— Discord 用户
          // 没法 tmux attach 按键。识别到就把 questions 渲染成 Discord select menu。
          // 渲染完跳过本 assistant entry 的其他处理（不进 textQueue / tools），由
          // AUQ 自己的交互回路驱动。
          //
          // v2.17.2: CC 2.1.x 把 AUQ tool_use 攒到用户作答后才连 tool_result 一起
          // 落盘 —— jsonl 读到时弹窗几乎必然已被应答（2026-08-07 migration 事故：
          // 检测比弹窗晚 4 分钟，还在人工作答后诈尸发卡）。及时通路已移到
          // permission-watcher 的 pane 侧检测；这里只兜底旧版 CC 的即时落盘：
          // pane 上弹窗还在才走注册+发卡，否则静默吞掉 entry。
          try {
            const { detectAskUserQuestion, postAskUserQuestionMessage, registerAuqState, auqStates } =
              await import("./ask-user-question.js");
            if (state.retired) break; // await 期间被停：这条及之后的都不发
            const questions = detectAskUserQuestion(content);
            if (questions) {
              if (!auqStates.has(state.channelId)) {
                let modalStillUp = false;
                try {
                  const pane = await tmuxCapture(windowTarget(state.agentName), 30);
                  modalStillUp = parseAuqPane(pane) !== null;
                } catch { /* 抓不到 pane 按弹窗不在处理 */ }
                if (state.retired) break;
                if (modalStillUp) {
                  const tmuxTarget = windowTarget(state.agentName);
                  // 先注册状态（与 Discord 渲染解耦）：web-only / Discord post 失败时
                  // /api/v1 answer 端点也能拿到 AuqState 下键。post 成功只回填 messageId。
                  registerAuqState(state.channelId, tmuxTarget, questions);
                  // M6：local-* 频道没有 Discord 面，跳过 post（event-bus 的 question 事件仍发，
                  // web 前端靠它渲染交互卡）。
                  if (!isLocalChannel(state.channelId)) {
                    postAskUserQuestionMessage(discord, state.channelId, tmuxTarget, questions)
                      .catch((e) => console.error("AUQ post 失败:", e));
                  }
                  console.log(`🎛 检测到 AskUserQuestion (${questions.length} 问) for ${state.agentName}`);
                  emitEvent({ agent: state.agentName, chatId: state.channelId, type: "question", data: { questions } });
                } else {
                  console.log(`🎛 AUQ tool_use 落盘时弹窗已不在（已被应答）→ 跳过发卡 for ${state.agentName}`);
                }
              }
              continue; // AUQ entry 一律不进 tool/text 渲染管线（pane 通路已处理或已应答）
            }
          } catch (e) { /* non-critical */ }

          // v2.21.1+ 回合态补正(owner 2026-09-02 截图实证:gc-car 工具卡在刷,
          // 侧栏却是绿点「已完成」、无停止按钮)。thinking 事件**只在 bridge
          // 投递消息时**发出;agent 自发开始的回合(compact 后继续、后台任务
          // 回调、ScheduleWakeup 自唤醒、注入的 slash 命令)从不经过 deliver,
          // event-bus 状态就停在上一次的 done。而 jsonl 是 CC 亲手写的——
          // 有新 assistant 内容 = 它确实在跑,这是最硬的「活着」信号。
          // 只在状态不是 thinking 时补一次,不刷屏。
          // ⚠ 只认**回合后的新活动**:watcher 是 2s poll + fs.watch,几乎总在 Stop
          // 之后才读到 Stop 前 0.1s 写的最后几条——「30s 内新鲜」挡不住这个,
          // 会把刚结束的回合重新点亮,再等 120s 对账才收敛(v2.21.3 事件环实测
          // 42 次 done 有 22 次被这样重点亮;owner:「真结束了还停在思考中」)。
          // 现在还要求记录时间晚于最近一次 done(isPostTurnActivity)。
          const entryTs = Date.parse(entry.timestamp || "");
          if (isPostTurnActivity(state.agentName, entryTs) && getAgentStatus(state.agentName) !== "thinking") {
            emitEvent({
              agent: state.agentName,
              chatId: state.channelId,
              type: "agent_status",
              data: { status: "thinking", trigger: "jsonl_activity" },
            });
          }

          const hasReply = content.some((b: any) => b.type === "tool_use" && isHiddenTool(b.name));
          // v2.20.2+「正在回复…」信号:看到 reply 工具调用就告诉 web 一声——
          // 长回合里用户能看到回复马上要来了(owner 实报)。只认 reply 本体,
          // 别的隐藏工具(react/edit_message)不算
          if (content.some((b: any) => b.type === "tool_use" && (b.name === "reply" || String(b.name || "").endsWith("__reply")))) {
            emitEvent({ agent: state.agentName, chatId: state.channelId, type: "reply_pending", data: { seq, sid: state.sessionId } });
          }
          const hasNewTools = content.some((b: any) => b.type === "tool_use" && b.name && !isHiddenTool(b.name));

          // 新一批 tool 到来 → 清空旧 tools，每轮独立一条 Discord 消息
          if (hasNewTools) {
            state.tools = [];
            state.toolMsgId = null;
          }

          for (const block of content) {
            if (block.type === "tool_use" && block.name && !isHiddenTool(block.name) && WATCHER_CONFIG.showToolUse) {
              const summary = formatTool(block.name, block.input);
              state.tools.push({
                id: block.id,
                summary,
                done: false,
                error: false,
              });
              toolsChanged = true;
              emitEvent({ agent: state.agentName, chatId: state.channelId, type: "tool_start", data: { toolId: block.id, name: block.name, summary, detail: formatToolDetail(block.name, block.input),
                seq, sid: state.sessionId } });
            }
            if (block.type === "text" && block.text?.trim() && WATCHER_CONFIG.showClaudeText && !hasReply) {
              // 以前有 `t.length > 3` 的 filter 防碎片短 text 刷屏，但那会把 "OK"
              // "收到" 这种合法短回复也吞掉。现在 rescue 删了 → watcher 是唯一
              // 文字出口，任何 trim 后非空的 text 都要推出来。
              const t = block.text.trim();
              // ACP 显式分类优先（false 禁止正文翻案）；老 CC / Codex 合成错误没这个字段，才按原文兼容识别。
              // ⛔ 与事件标记共用这一判定，额度闸据此撤掉旧续跑，后续 turn_duration 也不算思考时长。
              if (typeof entry.rateLimited === "boolean" ? entry.rateLimited : (state.apiErrorTurn || entry.error != null) && isLimitHitText(t)) {
                state.textQueue.push(`⛔ ${t}`);
                state.rateLimited = true;
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: t, rateLimited: true, apiError: !!state.apiErrorTurn,
                  seq, sid: state.sessionId } });
              } else {
                state.textQueue.push(`💬 ${t}`); // apiError：网页画成一行系统提示、连续相同的合并（web/features/chat/notice-merge.ts）
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: t, seq, sid: state.sessionId,
                  ...(state.apiErrorTurn ? { apiError: true } : {}) } });
              }
              if (!state.apiErrorTurn) state.answerParts.push(t); // 错误原文不算答复；Codex 额度那句算（它的 StopFailure 要把它推给 caller）
            }
            // v2.21.3+ Fable 5.1 的进度句:Anthropic 文档所说的 progress-update thinking
            // 块(CC 2.1.25x 请求 display=updates,落盘为**非空** thinking)。5.1 在长工具链
            // 里明显少写 text——实测带 text 的 assistant 条目 9.7%,Fable 5 是 13.8%——
            // 改把「接下来我会…」写进这里;不转发的话 web/Discord 上 5.1 agent 看着比旧
            // 模型沉默得多(其实它说了,是我们没转)。判定与历史解析共用 progressNoteOf。
            if (block.type === "thinking" && WATCHER_CONFIG.showClaudeText && !hasReply) {
              const note = progressNoteOf(block);
              if (note) {
                state.textQueue.push(`💭 ${note}`);
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: note, progress: true, seq, sid: state.sessionId } });
              }
            }
          }
        }

        if (entry.type === "user") {
          const content = entry.message?.content;
          // 新一轮的用户提示（不是 tool_result）：上一轮的 API 错误标记作废，否则正常结束的这一轮会被当成出错不结算
          if (!Array.isArray(content) || !content.some((b) => b?.type === "tool_result")) state.apiErrorTurn = false;
          // 打断标记 / 人在终端里敲的新输入：打断记录据此认出「人在终端里叫停」和「叫停之后又开口了」（lib/turn-cuts.ts transcriptUserEvent）
          const ue = transcriptUserEvent(entry, state.runtime);
          if (ue) emitEvent({ agent: state.agentName, chatId: state.channelId, type: ue.type, data: { ts: entry.timestamp, ...ue.data } }, ue);
          if (!Array.isArray(content)) continue;
          const auq = auqEchoCard(entry, formatToolDetail); // AUQ 作答补一张已完成的卡（lib/auq-echo.ts）
          if (auq) emitEvent({ agent: state.agentName, chatId: state.channelId, type: "tool_start", data: { ...auq, seq, sid: state.sessionId } });
          for (const block of content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              // 并行 tool_use 各占一条 jsonl、新一条会清空 state.tools：前面几个的结果这里找不到，但 tool_start 发过了，tool_done 照发
              const tool = state.tools.find((t) => t.id === block.tool_use_id);
              if (tool?.done) continue;
              if (tool) [tool.done, tool.error, toolsChanged] = [true, !!block.is_error, true];
              emitEvent({ agent: state.agentName, chatId: state.channelId, type: "tool_done", data: { toolId: block.tool_use_id, error: !!block.is_error } });
            }
          }
        }
      } catch (e) { console.error(`⚠️ 条目处理失败，agent=${state.agentName}: ${String(e)}`); if (pushed) lost++; }
    }

    if (toolsChanged && !state.retired) {
      if (state.textQueue.length > 0) {
        if (state.textTimer) { clearTimeout(state.textTimer); state.textTimer = null; }
        await flushText(state, discord);
      }
      await syncToolMsg(state, discord);
    }

    if (state.textQueue.length > 0 && !state.retired) {
      if (state.textTimer) clearTimeout(state.textTimer);
      state.textTimer = setTimeout(() => flushText(state, discord), WATCHER_CONFIG.debounceMs);
    }
  // 推送时前面的条目可能已经发到频道；确认这批并报丢失，避免重送造成重复正文。
  } catch (e) { console.error(`⚠️ 读取条目失败，agent=${state.agentName}: ${String(e)}`); return pushed ? { ok: true, lost: pushed.length } : { ok: false, lost: 0 }; }
  finally { state.processing = false; }
  return { ok: true, lost };
}

/**
 * Stop hook 触发时同步 drain 一个 channel 的 watcher：
 * - 立刻读一次 jsonl 到最新（即便 fs.watch / 2s poll 都还没 fire）
 * - 取消 pending 的 debounce timer
 * - 立刻 flush textQueue 到 Discord
 *
 * 这样 turn 结束的"快速一句话"场景不会因为 watcher debounce 1.5s 还没过就被
 * Stop 吞掉，同时也不需要 rescue 做第二遍代发。
 */
export async function drainChannelWatcher(
  channelId: string,
  discord: Client,
): Promise<{ drained: boolean; text: string | null; apiError?: boolean; error?: { error: string; text: string }; turnMark?: string }> {
  for (const state of watchers.values()) {
    if (state.channelId !== channelId) continue;
    try {
      await processNewData(state, discord);
    } catch { /* non-critical */ }
    if (state.textTimer) {
      clearTimeout(state.textTimer);
      state.textTimer = null;
    }
    // flushText 清掉之前先截一份没发出去的答复原文给 Stop 兜底 pushback（不带 `-# ` 前缀、不含 ⏱/📦 这类提示和 API 错误原文）
    const captured = state.answerParts.join("\n").trim() || null;
    if (state.textQueue.length > 0) {
      try { await flushText(state, discord); } catch { /* non-critical */ }
    }
    const turnMark = state.lastAssistantSeq === undefined ? undefined : `${state.sessionId}:${state.cursor?.source ?? "push"}:${state.lastAssistantSeq}`;
    return { drained: true, text: captured, apiError: !!state.apiErrorTurn, ...(state.apiErrorTurn ? { error: state.apiErrorTurn } : {}), turnMark };
  }
  return { drained: false, text: null };
}

// v2.4.14+ create 路径 race 兜底：channel-server register 时 Claude Code 可能还
// 没生成 jsonl 文件（实测 ~20s 延迟）。之前 `existsSync` false 就静默 return，
// 文件出现后没人重试 → watcher 永远不启动 → 用户看不到 tool stream，只见到 reply。
// 现在改成 poll 等候，文件一出现就接上 watcher，上限 60s。
const pendingStartTimers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; channelId: string; sessionId: string; startedAt: number }
>();
const PENDING_POLL_MS = 2000;
// 10min(曾 60s):新建 agent 的 jsonl 要等**首条消息**才落盘,用户建完隔几分钟
// 才开口是常态——60s 放弃 = watcher 永久缺位(工具/文本从不直播,Stop done 挂
// '?' 名下,busy 卡 thinking「工作中」,2026-07-24 wechat-bot)。放弃后还有
// deliverToLocal 的入站自愈兜底,这里只是第一道。poll 是 2s 一次 stat,便宜。
const PENDING_MAX_WAIT_MS = 600_000;
/** 频道的安装代次：跨 await 回来代次已变的旧调用不装资源、不写 map（bridge/watcher-ownership-gen.ts） */
const gens = new InstallGenerations();

type WatchOptions = { runtime?: string; sessionFile?: string; transport?: string; rebind?: boolean };
export async function startWatching(agentName: string, cwd: string, sessionId: string, channelId: string, discord: Client, opts: WatchOptions = {}) {
  const { runtime, sessionFile } = opts;
  const tok = gens.begin(channelId, agentName, sessionId);
  if (opts.transport === "acp" || isAcpChannel(channelId)) return void await installAcpPushWatcher(channelId, sessionId, !!opts.rebind, () => {
    const name = gens.owner(tok); // await 期间 rescan 可能已改名：按当前可信归属装
    if (!name) return void console.log(`👁 推送登记已被更新的一代取代: ${agentName}`);
    releaseChannel(channelId); release(name); startPushWatcher(name, sessionId, channelId, runtime);
  }).finally(() => gens.done(tok));
  const jsonlPath = resolveSessionPath(runtime, cwd, sessionId, sessionFile);
  // 同一频道同一会话文件重新登记（两份 channel-server 对抢、bridge 重连、rename 后新名登记）不重启、只改挂名字：新 watcher 从文件末尾起读，两次之间写的行会丢
  const cur = jsonlPath ? [...watchers.values()].find((s) => s.channelId === channelId && s.jsonlPath === jsonlPath && s.sessionId === sessionId) : undefined;
  if (cur) {
    gens.done(tok);
    if (cur.agentName !== agentName) { release(agentName); moveLabel(watchers, cur, agentName); }
    return void console.log(`👁 监听沿用: ${agentName}`);
  }
  releaseChannel(channelId); release(agentName); // 同频道旧名字的也停：按频道 stop 只停第一条时会留下双 watcher
  if (!jsonlPath) return void (startPending(agentName, cwd, sessionId, channelId, discord, opts), gens.done(tok));
  try {
    const cursor = await tailReadCursor(jsonlPath);
    const name = gens.owner(tok); // await 期间 rescan 改名的话装在新名下
    if (!name) return void console.log(`👁 安装已被更新的一代取代，放弃: ${agentName} (${sessionId.slice(0, 8)})`);
    releaseChannel(channelId); release(name); // await 期间别处装过必然换代，这里同步保底
    installTail({ agentName: name, jsonlPath, cursor, sessionId, channelId, runtime }, discord);
  } finally { gens.done(tok); }
}

function installTail(o: Pick<WatcherState, "agentName" | "jsonlPath" | "sessionId" | "channelId" | "runtime"> & { cursor: ReadCursor }, discord: Client): void {
  const state: WatcherState = { ...o, watcher: null as any, translationScope: {}, lineNo: o.cursor.lineNo, tools: [], toolMsgId: null, textQueue: [],
    answerParts: [], textTimer: null, processing: false, pollInterval: null, rateLimited: false };
  // fs.watch 主监听；文件在 await 之后没了会抛：此时还没有轮询、也没进 map，不泄漏
  state.watcher = watch(o.jsonlPath, (eventType) => { if (eventType === "change") processNewData(state, discord); });
  // 轮询兜底（macOS fs.watch 偶尔丢事件;丢失时延迟全由这里决定——
  // 2s 曾是 web 端比终端慢几秒的主要成分,现 500ms,见 WATCHER_CONFIG.pollMs）
  state.pollInterval = setInterval(() => processNewData(state, discord), WATCHER_CONFIG.pollMs);
  // 空闲检测由 Claude Code hooks (Stop/Notification) 处理，不再用 tmux 屏幕比较
  watchers.set(o.agentName, state);
  console.log(`👁 开始监听: ${o.agentName} → ${o.jsonlPath}`);
}

function startPending(agentName: string, cwd: string, sessionId: string, channelId: string, discord: Client, opts: WatchOptions): void {
  const { runtime, sessionFile } = opts;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const name = [...pendingStartTimers].find(([, p]) => p.timer === timer)?.[0]; // rename 会把等候改挂到新名下
    if (!name) return void clearInterval(timer);
    // ⚠ 每拍重新解析：Pi 的会话文件是「先有目录、后有文件」，路径只能扫出来
    const hit = resolveSessionPath(runtime, cwd, sessionId, sessionFile);
    if (hit) {
      clearInterval(timer);
      pendingStartTimers.delete(name);
      console.log(`👁 JSONL 出现，启动 watcher: ${name} (等了 ${Date.now() - startedAt}ms)`);
      startWatching(name, cwd, sessionId, channelId, discord, { runtime, sessionFile }).catch((err) => console.error(`pending watcher 启动失败: ${name}`, err));
      return;
    }
    if (Date.now() - startedAt > PENDING_MAX_WAIT_MS) {
      clearInterval(timer);
      pendingStartTimers.delete(name);
      console.warn(`⚠️  JSONL ${PENDING_MAX_WAIT_MS}ms 没出现，放弃 watcher: ${name} (runtime=${runtime ?? "claude-code"})`);
    }
  }, PENDING_POLL_MS);
  pendingStartTimers.set(agentName, { timer, channelId, sessionId, startedAt });
  console.log(`⏳ JSONL 暂不存在，poll 等候: ${agentName} (runtime=${runtime ?? "claude-code"})`);
}

/** 停下某名字的资源（不换代，startWatching 内部用）：等候定时器、fs.watch、轮询；推送 watcher 收着等同会话再登记 */
function release(agentName: string): void {
  // 也清掉 pending-start 的 poll 定时器，避免 agent 被 kill / restart 后旧的 poll 还在跑 → 文件出现时启动一个错的 watcher
  const pending = pendingStartTimers.get(agentName);
  if (pending) {
    clearInterval(pending.timer);
    pendingStartTimers.delete(agentName);
  }
  const state = watchers.get(agentName);
  if (!state) return;
  state.watcher?.close();
  if (state.push) park(state); // 推送 watcher 先收着（定时 flush 照跑），同一会话再登记接着用
  else {
    state.retired = true;
    if (state.textTimer) clearTimeout(state.textTimer);
  }
  if (state.pollInterval) clearInterval(state.pollInterval);
  watchers.delete(agentName);
}

/** 一个频道只收着一份推送 watcher：rename 前旧名下收着的那份不再留（它已排好的 flush 照跑一次） */
function park(state: WatcherState): void {
  for (const [n, p] of [...parkedPush]) if (p.channelId === state.channelId) parkedPush.delete(n);
  parkedPush.set(state.agentName, state);
}

function releaseChannel(channelId: string): void {
  for (const [n, p] of [...pendingStartTimers]) if (p.channelId === channelId) release(n);
  for (const [n, s] of [...watchers]) if (s.channelId === channelId) release(n);
}

function moveLabel(map: Map<string, WatcherState>, state: WatcherState, to: string): void {
  map.delete(state.agentName);
  state.agentName = to;
  map.set(to, state);
}

export function stopWatching(agentName: string) {
  gens.cancelAgent(agentName); // 这个名字发起、还在 await 的安装回来后放弃
  release(agentName);
}

/** ACP 宿主的频道：只推送、不碰文件（按 acp-state 认）。同一会话重新登记沿用该频道收着的那份（未 flush 的正文、答复、序号）；新建的序号从当前毫秒起，bridge 重启也不回退 */
function startPushWatcher(agentName: string, sessionId: string, channelId: string, runtime?: string): void {
  const [parkedName, parked] = [...parkedPush].find(([, p]) => p.channelId === channelId) ?? [];
  if (parkedName) parkedPush.delete(parkedName);
  parkedPush.delete(agentName);
  if (parked?.sessionId === `acp:${sessionId}`) return void (parked.agentName = agentName, watchers.set(agentName, parked), console.log(`👁 推送沿用: ${agentName}`));
  const state = { watcher: null, jsonlPath: "", sessionId: `acp:${sessionId}`, lineNo: Date.now(), channelId, tools: [], toolMsgId: null, textQueue: [],
    answerParts: [], textTimer: null, agentName, runtime, processing: false, pollInterval: null, rateLimited: false, push: true } as unknown as WatcherState;
  watchers.set(agentName, state);
  console.log(`👁 开始接收推送: ${agentName}（ACP 宿主）`);
}

/** ACP 宿主推来的一批 CC 形状条目（bridge/acp-link.ts）：走和尾读同一条解析，工具 / 正文 / 状态事件照发 */
export async function pushEntries(channelId: string, entries: object[], discord: Client, sessionId?: string): Promise<{ ok: boolean; lost: number }> {
  const state = [...watchers.values()].find((s) => s.channelId === channelId && s.push);
  return state && (!sessionId || state.sessionId === `acp:${sessionId}`) ? processNewData(state, discord, entries) : { ok: false, lost: 0 };
}
/** v2.6.0+ channelId → agent 名反查（event-bus 埋点用，避免热路径查 registry） */
export function agentNameForChannel(channelId: string): string | null {
  for (const [agentName, p] of pendingStartTimers.entries()) {
    if (p.channelId === channelId) return agentName;
  }
  for (const [agentName, state] of watchers.entries()) {
    if (state.channelId === channelId) return agentName;
  }
  return null;
}

/** 可信登记（rescan）的名字 ↔ 频道 ↔ 会话：同频道同会话的 watcher / 等候 / 收着的推送 / 在途安装改挂新名，不重读尾、不丢未发正文。新名已被别的占着就不盖 */
export function relabelChannelOwner(o: OwnerRef): number {
  const same = (sid: string) => sid === o.sessionId || sid === `acp:${o.sessionId}`;
  let n = gens.relabel(o); // 正在 stat / 数行 await 的安装也改归新名
  for (const map of [watchers, parkedPush]) {
    for (const s of [...map.values()]) {
      if (s.agentName === o.name || s.channelId !== o.channelId || !same(s.sessionId) || map.has(o.name)) continue;
      moveLabel(map, s, o.name);
      n++;
    }
  }
  for (const [name, p] of [...pendingStartTimers]) {
    if (name === o.name || p.channelId !== o.channelId || p.sessionId !== o.sessionId || pendingStartTimers.has(o.name)) continue;
    pendingStartTimers.delete(name);
    pendingStartTimers.set(o.name, p);
    n++;
  }
  return n;
}

/** 按 channelId 停掉该频道的全部资源（websocket 断开时兜底用）：所有名字下的 watcher / 等候，并换代取消安装中的；推送的照旧收着 */
export function stopWatchingByChannel(channelId: string): boolean {
  const had = gens.cancel(channelId) || agentNameForChannel(channelId) !== null;
  releaseChannel(channelId);
  return had;
}

/** 重置 tool 追踪（新一轮对话开始时调用） */
export function resetToolTracking(channelId: string) {
  for (const state of watchers.values()) {
    if (state.channelId === channelId) {
      state.tools = [];
      state.toolMsgId = null;
    }
  }
}

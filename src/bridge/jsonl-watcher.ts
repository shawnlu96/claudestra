/**
 * JSONL Session File Watcher
 *
 * 监听 Claude Code 的 JSONL session 文件。
 * Tool use 实时推送到 Discord，一条消息持续 edit 更新状态。
 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import { WATCHER_CONFIG, MCP_TOOL_PREFIX } from "./config.js";
import { discordReply } from "./discord-api.js";
import { projectsSlug, findJsonlBySessionId } from "../lib/jsonl-cost.js";
import { tmuxCapture, windowTarget } from "../lib/tmux-helper.js";
import { parseAuqPane } from "../lib/auq-pane.js";
import { progressNoteOf } from "../lib/session-history.js";
// v2.6.0+ 旁路事件埋点（设计 D1：只 emit 不改渲染管线）
import { emitEvent, getAgentStatus } from "./event-bus.js";

interface ToolEntry {
  id: string;
  summary: string;
  done: boolean;
  error: boolean;
}

interface WatcherState {
  watcher: FSWatcher;
  jsonlPath: string;
  lastSize: number;
  channelId: string;
  tools: ToolEntry[];
  toolMsgId: string | null;
  textQueue: string[];
  textTimer: ReturnType<typeof setTimeout> | null;
  agentName: string;
  /** 并发锁：processNewData 同时只能跑一份 */
  processing: boolean;
  /** 2s poll 兜底的 interval handle */
  pollInterval: ReturnType<typeof setInterval> | null;
  /**
   * 本轮是否命中 rate-limit（Claude Code 在 assistant text 里打"You've hit
   * your limit · resets ..."）。下一条 turn_duration 就不 push 了 —— rate-limit
   * 的 turn_duration 是"卡住被拒"的时长，对用户没意义，跟 limit 消息一起显
   * 反而刷屏。读到任何非 limit 的 assistant text 时 reset flag。
   */
  rateLimited: boolean;
}

const watchers = new Map<string, WatcherState>();

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

// v2.8+ 导出：bg-activity-watcher 渲染 subagent 的工具调用时复用同一套格式
export function formatTool(name: string, input: any): string {
  const E: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "💻",
    Glob: "🔍", Grep: "🔎", Agent: "🤖", WebSearch: "🌐",
  };
  const e = E[name] || "🔧";
  switch (name) {
    case "Read": return `${e} Read ${input?.file_path?.split("/").pop() || ""}`;
    case "Edit": return `${e} Edit ${input?.file_path?.split("/").pop() || ""}`;
    case "Write": return `${e} Write ${input?.file_path?.split("/").pop() || ""}`;
    case "Bash":
      if (input?.description) return `${e} ${input.description} ||${(input?.command || "").replace(/\n/g, " ").slice(0, 200)}||`;
      return `${e} ${(input?.command || "").split("\n")[0].split("&&")[0].trim()}`;
    case "Glob": return `${e} Glob ${input?.pattern || ""}`;
    case "Grep": return `${e} Grep ${input?.pattern || ""}`;
    // v2.15+ 任务清单工具:通用「🔧 TaskCreate」不知所云,渲染成人话
    case "TaskCreate": return `🗒️ 新任务：${(input?.subject || "").slice(0, 80)}`;
    case "TaskUpdate": {
      const st = input?.status ? ` → ${input.status}` : "";
      return `🗒️ 任务 #${input?.taskId ?? "?"}${st}`;
    }
    default: {
      // v2.17.2(peer 2026-08-09):send_to_agent 出站在前端此前只剩工具名,target
      // 和正文全丢——owner 看不到本地→peer 说了什么(半边对话)。它的正文没有
      // 任何其它渠道会显示(不同于 reply 本身就作为消息渲染,故 isReplyTool 过滤
      // 它是对的),省略等于纯丢信息。这里提取 target + 正文首段。
      if (name.endsWith("__send_to_agent")) {
        const target = input?.target ? `→ ${input.target}` : "";
        const body = String(input?.text || "").replace(/\n/g, " ").trim().slice(0, 200);
        return `🤝 send_to_agent ${target}${body ? `：${body}` : ""}`.trim();
      }
      // mcp__server__tool → server/tool
      const short = name.startsWith("mcp__") ? name.replace("mcp__", "").replace("__", "/") : name;
      return `${e} ${short}`;
    }
  }
}

/**
 * 工具调用完整详情——web 工具卡点开后展示（摘要只够一眼扫过，
 * 「mem0 write 到底写了啥」这类问题要看完整入参）。随 tool_start 事件
 * 和历史 tools[] 一起下发。截断上限防单条事件撑爆 SSE / 环形缓冲。
 */
const TOOL_DETAIL_MAX = 4000;

export function formatToolDetail(name: string, input: any): string {
  let out: string;
  switch (name) {
    case "Read":
      out = [
        input?.file_path || "",
        input?.offset != null ? `offset=${input.offset}` : "",
        input?.limit != null ? `limit=${input.limit}` : "",
      ].filter(Boolean).join("\n");
      break;
    case "Edit":
      out = `${input?.file_path || ""}\n─── old ───\n${input?.old_string ?? ""}\n─── new ───\n${input?.new_string ?? ""}`;
      break;
    case "Write":
      out = `${input?.file_path || ""}\n───\n${input?.content ?? ""}`;
      break;
    case "Bash":
      out = [input?.description, input?.command].filter(Boolean).join("\n───\n");
      break;
    default:
      // send_to_agent 详情:target + expecting + 正文原文(不 JSON 转义——正文是
      // 给人读的长文,几千字的 bug 报告 JSON.stringify 成一坨 \n 没法看,peer 2026-08-09)
      if (name.endsWith("__send_to_agent")) {
        out = [
          input?.target ? `→ ${input.target}` : "",
          input?.expecting ? `[期望] ${input.expecting}` : "",
          input?.text || "",
        ].filter(Boolean).join("\n───\n");
        break;
      }
      try {
        out = JSON.stringify(input ?? {}, null, 2);
      } catch {
        out = String(input);
      }
  }
  out = (out || "").trim();
  if (out.length > TOOL_DETAIL_MAX) {
    out = out.slice(0, TOOL_DETAIL_MAX) + `\n… (已截断，完整 ${out.length} 字符)`;
  }
  return out;
}

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
  if (isLocalChannel(state.channelId)) { state.textQueue.length = 0; return; }
  const items = state.textQueue.splice(0);
  const body = items.map((item) => `-# ${item}`).join("\n");
  try {
    await discordReply(discord, state.channelId, body);
  } catch { /* non-critical */ }
  state.toolMsgId = null;
  state.tools = state.tools.filter(t => !t.done);
}

export function getJsonlPath(cwd: string, sessionId: string): string {
  return join(process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * agent session jsonl 的最近写入时间（ms epoch），没有则 null。
 *
 * 用于 wedge-watcher 判断 agent 是否真在干活：Claude 思考 / 调工具时 jsonl 一直
 * 在追加，mtime 会很新。只看 tmux pane 指纹会把"思考中但屏幕暂时没变"误判成卡死，
 * jsonl mtime 是权威进度信号。
 */
export async function getJsonlMtime(cwd: string, sessionId: string): Promise<number | null> {
  try {
    const s = await stat(getJsonlPath(cwd, sessionId));
    return s.mtimeMs;
  } catch {
    return null;
  }
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
    const jsonlPath = getJsonlPath(cwd, sessionId);
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
          if (item?.type === "tool_use" && item?.name === "ScheduleWakeup") {
            return true;
          }
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
async function processNewData(state: WatcherState, discord: Client): Promise<void> {
  // v2.0.18+ race fix: 之前是 `if (state.processing) return` 直接 bail。问题：
  // Claude Code 写入 jsonl → fs.watch fire → 第一次 processNewData 进 await stat /
  // await read 阶段（async I/O，要十几到上百 ms）→ 期间 Stop hook 抵达 →
  // drainChannelWatcher 调 processNewData 看到 state.processing=true 立刻 return →
  // drain 跑到 flushText 时 textQueue 还是空（第一次 push 还没发生）→ 用户只看到
  // 「✅ 完成」空通知。
  //
  // 改成"等上一次跑完再做"。两路 processNewData 序列化：第一次 push 完了第二次
  // 才进，第二次的 newStat 看到 lastSize 已被更新，没新数据，直接退出 —— 但此时
  // textQueue 已经被第一次填好了，drain 后续的 flush 就能拿到。
  //
  // 锁等待带 5s 上限防 hang（理论上不应该；processNewData 内部 await 都是 fs / parse，
  // 不会卡住）。
  const lockWaitStart = Date.now();
  while (state.processing) {
    if (Date.now() - lockWaitStart > 5000) {
      console.error(`⚠️ processNewData 等锁超过 5s 放弃，agent=${state.agentName}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  state.processing = true;
  try {
    const newStat = await stat(state.jsonlPath);
    if (newStat.size <= state.lastSize) return;
    const newData = await Bun.file(state.jsonlPath).slice(state.lastSize, newStat.size).text();
    state.lastSize = newStat.size;

    let toolsChanged = false;

    for (const line of newData.split("\n").filter((l) => l.trim())) {
      try {
        const entry = JSON.parse(line);

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
            const questions = detectAskUserQuestion(content);
            if (questions) {
              if (!auqStates.has(state.channelId)) {
                let modalStillUp = false;
                try {
                  const pane = await tmuxCapture(windowTarget(state.agentName), 30);
                  modalStillUp = parseAuqPane(pane) !== null;
                } catch { /* 抓不到 pane 按弹窗不在处理 */ }
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
          // ⚠ 只认**新鲜**记录:watcher 是 2s poll + fs.watch,可能在 Stop 之后
          // 才读到 Stop 之前写的内容——拿它补 thinking 会把已结束的回合重新点亮
          // 并卡住(要等 120s 对账才收敛)。30s 外的旧记录一律不补。
          const entryTs = Date.parse(entry.timestamp || "");
          const fresh = Number.isFinite(entryTs) && Date.now() - entryTs < 30_000;
          if (fresh && getAgentStatus(state.agentName) !== "thinking") {
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
            emitEvent({ agent: state.agentName, chatId: state.channelId, type: "reply_pending", data: {} });
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
              emitEvent({ agent: state.agentName, chatId: state.channelId, type: "tool_start", data: { toolId: block.id, name: block.name, summary, detail: formatToolDetail(block.name, block.input) } });
            }
            if (block.type === "text" && block.text?.trim() && WATCHER_CONFIG.showClaudeText && !hasReply) {
              // 以前有 `t.length > 3` 的 filter 防碎片短 text 刷屏，但那会把 "OK"
              // "收到" 这种合法短回复也吞掉。现在 rescue 删了 → watcher 是唯一
              // 文字出口，任何 trim 后非空的 text 都要推出来。
              const t = block.text.trim();
              // Claude Code 把 rate-limit 命中的提示当 assistant text 写进 jsonl，
              // 像 "You've hit your limit · resets 2am (Asia/Shanghai)"。不应该按
              // 常规 💬 发（会让 agent 看着像正常输出），换成 ⛔ 标记 + 置 flag
              // 让后面的 turn_duration 也跳过。
              if (/You['']?ve hit your limit|Hit your (rate )?limit/i.test(t)) {
                state.textQueue.push(`⛔ ${t}`);
                state.rateLimited = true;
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: t, rateLimited: true } });
              } else {
                state.textQueue.push(`💬 ${t}`);
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: t } });
              }
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
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "assistant_text", data: { text: note, progress: true } });
              }
            }
          }
        }

        if (entry.type === "user") {
          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const tool = state.tools.find((t) => t.id === block.tool_use_id);
              if (tool && !tool.done) {
                tool.done = true;
                tool.error = !!block.is_error;
                toolsChanged = true;
                emitEvent({ agent: state.agentName, chatId: state.channelId, type: "tool_done", data: { toolId: block.tool_use_id, error: tool.error } });
              }
            }
          }
        }
      } catch { /* non-critical */ }
    }

    if (toolsChanged) {
      if (state.textQueue.length > 0) {
        if (state.textTimer) { clearTimeout(state.textTimer); state.textTimer = null; }
        await flushText(state, discord);
      }
      await syncToolMsg(state, discord);
    }

    if (state.textQueue.length > 0) {
      if (state.textTimer) clearTimeout(state.textTimer);
      state.textTimer = setTimeout(() => flushText(state, discord), WATCHER_CONFIG.debounceMs);
    }
  } catch { /* non-critical */ }
  finally { state.processing = false; }
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
): Promise<{ drained: boolean; text: string | null }> {
  for (const state of watchers.values()) {
    if (state.channelId !== channelId) continue;
    try {
      await processNewData(state, discord);
    } catch { /* non-critical */ }
    if (state.textTimer) {
      clearTimeout(state.textTimer);
      state.textTimer = null;
    }
    let captured: string | null = null;
    if (state.textQueue.length > 0) {
      // v2.0.13+: 在 flushText splice 掉 textQueue 之前先截一份。Stop hook 兜底
      // pushback 需要这段原文（不要带 flushText 加的 `-# ` 前缀）。
      // 只保留 `💬 ` / `⛔ ` 前缀的真 assistant 文字，跳过 ⏱/📖/✏️ 这种 telemetry。
      const assistantOnly = state.textQueue
        .filter((item) => item.startsWith("💬 ") || item.startsWith("⛔ "))
        .map((item) => item.replace(/^[💬⛔]\s+/u, ""))
        .join("\n")
        .trim();
      captured = assistantOnly || null;
      try { await flushText(state, discord); } catch { /* non-critical */ }
    }
    return { drained: true, text: captured };
  }
  return { drained: false, text: null };
}

// v2.4.14+ create 路径 race 兜底：channel-server register 时 Claude Code 可能还
// 没生成 jsonl 文件（实测 ~20s 延迟）。之前 `existsSync` false 就静默 return，
// 文件出现后没人重试 → watcher 永远不启动 → 用户看不到 tool stream，只见到 reply。
// 现在改成 poll 等候，文件一出现就接上 watcher，上限 60s。
const pendingStartTimers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; channelId: string; startedAt: number }
>();
const PENDING_POLL_MS = 2000;
// 10min(曾 60s):新建 agent 的 jsonl 要等**首条消息**才落盘,用户建完隔几分钟
// 才开口是常态——60s 放弃 = watcher 永久缺位(工具/文本从不直播,Stop done 挂
// '?' 名下,busy 卡 thinking「工作中」,2026-07-24 wechat-bot)。放弃后还有
// deliverToLocal 的入站自愈兜底,这里只是第一道。poll 是 2s 一次 stat,便宜。
const PENDING_MAX_WAIT_MS = 600_000;

export async function startWatching(
  agentName: string, cwd: string, sessionId: string,
  channelId: string, discord: Client
) {
  stopWatching(agentName);
  let jsonlPath = getJsonlPath(cwd, sessionId);

  // 推算路径不存在 → 按 sessionId 全 projects 扫一遍兜底（slug 规则漂移 /
  // cwd 记录不准时自愈，而不是傻等一个永远不会出现的文件）
  if (!existsSync(jsonlPath)) {
    const found = findJsonlBySessionId(sessionId);
    if (found) {
      console.log(`👁 slug 推算落空，按 sessionId 兜底命中: ${agentName} → ${found}`);
      jsonlPath = found;
    }
  }

  if (!existsSync(jsonlPath)) {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (existsSync(jsonlPath)) {
        clearInterval(timer);
        pendingStartTimers.delete(agentName);
        console.log(
          `👁 JSONL 出现，启动 watcher: ${agentName} (等了 ${Date.now() - startedAt}ms)`
        );
        startWatching(agentName, cwd, sessionId, channelId, discord).catch((err) =>
          console.error(`pending watcher 启动失败: ${agentName}`, err)
        );
        return;
      }
      if (Date.now() - startedAt > PENDING_MAX_WAIT_MS) {
        clearInterval(timer);
        pendingStartTimers.delete(agentName);
        console.warn(
          `⚠️  JSONL ${PENDING_MAX_WAIT_MS}ms 没出现，放弃 watcher: ${agentName} → ${jsonlPath}`
        );
      }
    }, PENDING_POLL_MS);
    pendingStartTimers.set(agentName, { timer, channelId, startedAt });
    console.log(
      `⏳ JSONL 暂不存在，poll 等候: ${agentName} → ${jsonlPath}`
    );
    return;
  }

  const fileStat = await stat(jsonlPath);
  const state: WatcherState = {
    watcher: null as any,
    jsonlPath,
    lastSize: fileStat.size,
    channelId,
    tools: [],
    toolMsgId: null,
    textQueue: [],
    textTimer: null,
    agentName,
    processing: false,
    pollInterval: null,
    rateLimited: false,
  };

  // fs.watch 主监听
  state.watcher = watch(jsonlPath, (eventType) => {
    if (eventType === "change") processNewData(state, discord);
  });

  // 轮询兜底（macOS fs.watch 偶尔丢事件;丢失时延迟全由这里决定——
  // 2s 曾是 web 端比终端慢几秒的主要成分,现 500ms,见 WATCHER_CONFIG.pollMs）
  const pollInterval = setInterval(() => processNewData(state, discord), WATCHER_CONFIG.pollMs);
  state.pollInterval = pollInterval;

  // 空闲检测由 Claude Code hooks (Stop/Notification) 处理，不再用 tmux 屏幕比较

  watchers.set(agentName, state);
  console.log(`👁 开始监听: ${agentName} → ${jsonlPath}`);
}

export function stopWatching(agentName: string) {
  // v2.4.14+ 也清掉 pending-start 的 poll 定时器，避免 agent 被 kill / restart 后
  // 旧的 poll 还在跑 → 文件出现时启动一个错的 watcher。
  const pending = pendingStartTimers.get(agentName);
  if (pending) {
    clearInterval(pending.timer);
    pendingStartTimers.delete(agentName);
  }
  const state = watchers.get(agentName);
  if (state) {
    state.watcher.close();
    if (state.textTimer) clearTimeout(state.textTimer);
    if (state.pollInterval) clearInterval(state.pollInterval);
    watchers.delete(agentName);
  }
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

/** 根据 channelId 查找并停止 watcher（websocket 断开时兜底用） */
export function stopWatchingByChannel(channelId: string): boolean {
  // 先查 pending-start 队列
  for (const [agentName, p] of pendingStartTimers.entries()) {
    if (p.channelId === channelId) {
      stopWatching(agentName);
      return true;
    }
  }
  for (const [agentName, state] of watchers.entries()) {
    if (state.channelId === channelId) {
      stopWatching(agentName);
      return true;
    }
  }
  return false;
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

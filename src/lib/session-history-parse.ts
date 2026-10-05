import { translateSessionLine } from "./session-source.js";
import { pushApiErrorRow } from "./api-error-rows.js";
import { channelAnswer, channelAttachments, channelBodyText, commandRecordLine, commandStdoutLine, senderOf, type AskAnswerRef, type InboundAttachmentsRef } from "./inbound-body.js";
import { ccOwnRecord, plainUserText, verifiedForeignRecord } from "./cc-own-records.js";
import type { InboundLookup } from "./inbound-ledger.js";
import { settleToolCard } from "./auq-echo.js";
import { dropFailedReplyRows, keepReplyRows, sanitizeComponents } from "./history-components.js";
import { askIdOfReplyResult } from "./reply-ask-schema.js";
import { inboxHistory } from "./session-history-inbox.js";
import type { HistoryMessage, HistoryToolCall, ReplyComponentRow } from "./session-history-types.js";

/**
 * v2.21.3+ 进度句长度上限。Fable 5.1 的 progress-update thinking 块实测中位 124 字、
 * 最长 247 字;超过这个数的 thinking 是 summarized 全量推理,不是进度句,不转发。
 * 旧模型/订阅会话的 thinking 全是空串(服务端 redact),天然不命中。
 */
export const PROGRESS_NOTE_MAX_CHARS = 800;

/** thinking 块 → 进度句(不是进度句返回 null)。watcher 与历史解析共用同一判定。 */
export function progressNoteOf(block: any): string | null {
  if (!block || block.type !== "thinking" || typeof block.thinking !== "string") return null;
  const t = block.thinking.trim();
  return t && t.length <= PROGRESS_NOTE_MAX_CHARS ? t : null;
}

/**
 * reply 工具名。两种形态都要认：
 *  - Claude Code：MCP 工具 `mcp__<MCP_NAME>__reply`（MCP_NAME 可配，按前后缀匹配）；
 *  - Pi（v2.23+）：扩展注册的**裸名** `reply`（Pi 没有 MCP，见 pi/claudestra-extension.ts）。
 *
 * 漏掉裸名的后果不是"少个标签"，而是**回复正文在历史里变成一张工具卡**：走下面的
 * else 分支后，summary 是「💬 回复」，正文被塞进 `detail` —— 也就是把 JSON 参数
 * 原样 dump 出来，`\n` 全是字面量。owner 2026-09-22 实报的就是这个（Pi 会话里
 * 一整段回复渲染成转义文本块，末尾还挂着个 `"`）。搜索那条路径（searchHistory）
 * 同样因此搜不到 Pi 的任何回复。
 *
 * jsonl-watcher 的 HIDDEN_TOOLS 与 reply_pending 早就认裸名了，这里是漏网的两处。
 */
export function isReplyTool(name: string): boolean {
  if (name === "reply") return true; // Pi 侧裸名
  return name.startsWith("mcp__") && name.endsWith("__reply");
}

// channel 送达的入站消息在 CC jsonl 里落成 isMeta:true + "<channel …>…</channel>"
// 包装的 user 记录（CC channel 协议原生格式）。这是真实对话输入（web/API 用户、
// Discord 用户、agent↔agent），不解包的话历史 API 里看不到任何用户消息，web 端
// 回合结构也随之丢失（连续 assistant 记录跨回合粘连成巨型气泡）。
const CHANNEL_WRAP_RE = /^\s*<channel\s+([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/channel>\s*$/;

/** attachment 记录是否为「被队列吸收的用户消息」,是则返回原始 prompt(含 channel 包装)。 */
export function queuedPromptOf(rec: any): string | null {
  const a = rec?.attachment;
  if (!a || a.type !== "queued_command" || a.commandMode !== "prompt") return null;
  return typeof a.prompt === "string" && a.prompt.trim() ? a.prompt : null;
}

/** <channel …> 包装里的 message_id 属性(bridge 给每条入站消息的唯一 id)。 */
export function channelMessageId(raw: string): string | null {
  return /<channel\s[^>]*\bmessage_id="([^"]+)"/.exec(raw)?.[1] ?? null;
}

/** 预扫描:所有 user(isMeta) 记录里 channel 消息的 message_id 集合(队列附件去重用)。 */
function collectChannelMessageIds(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    if (!/"isMeta"\s*:\s*true/.test(l) || !l.includes("message_id=")) continue;
    let rec: any;
    try { rec = JSON.parse(l); } catch { continue; }
    if (rec?.type !== "user") continue;
    const c = rec.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text || "" : "")).join("\n") : "";
    const mid = channelMessageId(text);
    if (mid) ids.add(mid);
  }
  return ids;
}

/**
 * 解包一条 <channel> 入站消息：返回 { text, from }；不是 channel 包装
 * （caveat / local-command 等真 meta）返回 null。
 */
export function unwrapChannelMessage(raw: string): ({ text: string; from?: string; fromId?: string } & AskAnswerRef & InboundAttachmentsRef) | null {
  const m = raw.match(CHANNEL_WRAP_RE);
  if (!m) return null;
  const from = /(?:^|\s)user="([^"]*)"/.exec(m[1])?.[1] || undefined;
  const fromId = /(?:^|\s)user_id="([^"]*)"/.exec(m[1])?.[1] || undefined;
  const text = channelBodyText(m[1], m[2]); // 剥注入头 + 补附件行（lib/inbound-body.ts）
  if (!text) return null;
  return { text, from, fromId, ...channelAnswer(m[1], m[2]), ...channelAttachments(m[1]) }; // 附件只取头属性：正文里的附件行不可信
}

/** <channel> 入站 → 历史里的一条用户消息；不是包装、或是 bridge 内部注入（user="bridge:*"，看门狗 nudge 等是指令不是对话，直播侧 srcKind 同款排除）→ null */
export function channelUserMessage(raw: string, seq: number, ts: string | null): HistoryMessage | null {
  const un = unwrapChannelMessage(raw);
  if (!un || (un.from && /^bridge(:|$)/.test(un.from))) return null;
  const msg: HistoryMessage = { seq, ts, role: "user", text: un.text };
  return Object.assign(msg, senderOf(un));
}

/** system 类记录（parseHistoryLines 用）：压缩分界线、斜杠命令、回合耗时回填。处理了返回 true，其它 system 记录不进历史 */
function applySystemRecord(rec: any, seq: number, ts: string | null, all: HistoryMessage[]): boolean {
  if (rec.type !== "system") return false;
  if (rec.subtype === "compact_boundary") {
    // 纯文本不带装饰——system 条目的分隔线样式由各前端自己渲染
    all.push({ seq, ts, role: "system", text: "上下文已压缩（compact）" });
    return true;
  }

  // 新版 CC 把斜杠命令和它的输出记成成对的 system/local_command（<command-name>… 一条、<local-command-stdout>… 一条），不认就整条从历史里消失
  if (rec.subtype === "local_command") {
    const raw = typeof rec.content === "string" ? rec.content : "";
    const out = commandStdoutLine(raw); // 先认输出：命令的输出里可能恰好印着 <command-name>…
    const text = out === undefined ? commandRecordLine(raw) : out;
    if (text) all.push({ seq, ts, role: "system", text });
    return true;
  }

  // turn_duration → 回填到刚结束的那轮 assistant 的 turnMs。
  // 只有正常收尾的回合才有这条(被打断的没有),前端据此给历史尾轮
  // 渲染「✓ 完成 · 12.3s」——切后台错过 done 事件后刷新也能看到完成态。
  if (rec.subtype === "turn_duration" && typeof rec.durationMs === "number") {
    for (let j = all.length - 1; j >= 0; j--) {
      if (all[j].role === "assistant") {
        all[j].turnMs = rec.durationMs;
        break;
      }
      if (all[j].role === "user") break; // 中间隔了用户消息就不回填
    }
    return true;
  }
  return false;
}

/**
 * 解析一段 jsonl 行为历史消息。seq = lineOffset + 行内下标,维持「全文件行号」
 * 坐标系(全读时 lineOffset=0;尾读时为窗口前缀的换行数)——与 searchSessionHistory
 * 的跳转锚同一套。
 *
 * ⚠ 尾读时跨窗口的回填会丢:tool_result 的 is_error 要回填到更早的 tool_use、
 * turn_duration 要回填到更早的 assistant,被回填对象若落在窗口之前就够不着。
 * 纯装饰(工具卡标红 / 尾轮「✓ 12.3s」)且只发生在窗口边界的极少数条目,可接受;
 * 需要精确就把 maxFullReadBytes 调大让该文件走全读。
 */
export function parseHistoryLines(
  lines: string[],
  lineOffset: number,
  fmt: (name: string, input: any) => string,
  detailFn: ((name: string, input: any) => string) | undefined,
  /** v2.23+ 运行时：Pi 的行要翻译成 Claude Code 形状后再解析 */
  runtime?: string,
  inbound?: InboundLookup,
): HistoryMessage[] {
  const all: HistoryMessage[] = [];
  // tool_use id → 工具卡 / reply 气泡：后续 user 记录里的 tool_result 回填失败态、建出的 askId
  const toolById = new Map<string, HistoryToolCall>();
  const replyById = new Map<string, HistoryMessage>(), replyRows = new Map<string, ReplyComponentRow[]>();
  // v2.21.4 队列附件去重:同一条入站消息若另有 user(isMeta) 记录,以 user 记录为准
  const seenChannelIds = collectChannelMessageIds(lines);
  const inbox = inboxHistory(); // check_inbox 领走的消息：拆进历史，同一 message_id 只出一次（lib/session-history-inbox.ts）

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const seq = lineOffset + i;
    const rec: any = translateSessionLine(runtime, lines[i], lines);
    if (!rec) continue;
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    if (applySystemRecord(rec, seq, ts, all)) continue; // 压缩分界 / 斜杠命令 / 回合耗时

    if (rec.type === "attachment") {
      // v2.21.4 被队列吸收的入站消息:agent 忙时 channel 送达的消息先进 CC 队列,随后
      // 「absorbed_mid_turn」并入当前回合——jsonl 里只落 attachment(queued_command,
      // commandMode=prompt),**没有** user 记录。不解析,历史就缺这条用户消息,web 的
      // 乐观气泡对不上账,30 分钟内每次对齐都被接回列表尾(owner 2026-09-04 截图
      // 「很久之前发的老消息总显示在最下面」)。commandMode=task-notification 是
      // harness 的后台任务通知,不进历史。
      const queued = queuedPromptOf(rec);
      if (queued) {
        const msg = channelUserMessage(queued, seq, ts);
        const mid = channelMessageId(queued);
        if (msg && (!mid || !seenChannelIds.has(mid)) && inbox.fresh(mid, msg)) all.push(msg);
      }
      continue;
    }

    if (rec.type === "user") {
      const c = rec.message?.content;
      // tool_result 回填：工具卡（失败标红、AUQ 换成作答摘要）；reply 的 → 气泡记下建出的 askId。不影响本条 user 记录自身的过滤，继续走原流程
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type !== "tool_result") continue;
        settleToolCard(toolById.get(b.tool_use_id), b, rec);
        const rm = replyById.get(b.tool_use_id);
        if (rm) rm.replyAskId = askIdOfReplyResult(b) ?? rm.replyAskId;
        if (rm && b.is_error === true) dropFailedReplyRows(rm, replyRows.get(b.tool_use_id)); // 被 bridge 拒发的 reply，按钮不进历史
        all.push(...inbox.expand(toolById.get(b.tool_use_id), b, seq, ts));
      }
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n")
            : "";
      const verified = verifiedForeignRecord(rec, text, runtime, inbound); // Pi / Codex 对上入站账的：按账上 meta 重渲染，同 CC 解包
      const plain = verified === undefined ? plainUserText(rec, text, runtime) : undefined; // 其余 Pi / Codex：原文照登，不认文本头（lib/cc-own-records.ts）
      if (plain !== undefined) { if (plain.trim()) all.push({ seq, ts, role: "user", text: plain }); continue; }
      if (rec.isMeta === true) {
        // isMeta + <channel> 包装 = channel 送达的真实入站消息，解包进历史；其余 isMeta（caveat / local-command 输出等）照旧过滤
        const msg = channelUserMessage(verified ?? text, seq, ts);
        if (msg && inbox.fresh(channelMessageId(verified ?? text), msg)) all.push(msg);
        continue;
      }
      if (!text.trim()) continue; // 纯 tool_result 载荷
      // CC 自己写的斜杠命令 / 命令输出 / 后台通知 / 中断标记不是用户打的字（lib/cc-own-records.ts）
      const own = ccOwnRecord(text.trim(), runtime);
      if (own) { if ("system" in own) all.push({ seq, ts, role: "system", text: own.system }); continue; }
      const msg: HistoryMessage = { seq, ts, role: "user", text };
      if (rec.isCompactSummary === true) msg.compactSummary = true;
      all.push(msg);
      continue;
    }

    if (rec.type === "assistant") {
      if (pushApiErrorRow(all, rec, seq, ts)) continue; // API 错误 → 一行系统提示，连续相同的并成 ×N（lib/api-error-rows.ts）
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      const replyTexts: string[] = [];
      const replyComponents: ReplyComponentRow[] = [];
      const replyFiles: string[] = [];
      const replyIds: string[] = [];
      const tools: HistoryToolCall[] = [];
      const progress: string[] = [];
      for (const b of content) {
        const note = progressNoteOf(b);
        if (note) progress.push(note);
        if (b?.type === "text" && b.text?.trim()) texts.push(b.text);
        else if (b?.type === "tool_use" && b.name) {
          // reply() 的正文是「发给用户的消息」，不是工具动作——提取成文本，别当
          // 工具卡（否则 formatTool 只剩「🔧 <server>/reply」，回复内容在历史里蒸发，
          // 直播能看到、进历史就没了）。这样历史与直播都渲染同一份 reply。
          if (isReplyTool(b.name) && typeof b.input?.text === "string" && b.input.text.trim()) {
            replyTexts.push(b.input.text);
            if (typeof b.id === "string" && b.id) replyIds.push(b.id);
            // reply 附带的按钮/选单也进历史（否则用户不在直播那刻就看不到按钮）
            replyComponents.push(...keepReplyRows(replyRows, b.id, sanitizeComponents(b.input?.components)));
            // 出站附件（agent 发给用户的图/文件）：jsonl 里是绝对路径,取 basename——bridge 投递时已拷贝到 inbox（时间戳前缀）,取回走后缀匹配兜底
            for (const f of Array.isArray(b.input?.files) ? b.input.files : []) {
              const base = typeof f === "string" ? f.trim().split("/").pop() : "";
              if (base) replyFiles.push(base);
            }
          } else {
            const tc: HistoryToolCall = { name: b.name, summary: fmt(b.name, b.input) };
            if (detailFn) {
              const dt = detailFn(b.name, b.input);
              if (dt) tc.detail = dt;
            }
            tools.push(tc);
            if (typeof b.id === "string" && b.id) toolById.set(b.id, Object.assign(tc, { id: b.id, open: true })); // 结果到了由 settleToolCard 摘掉 open
          }
        }
      }
      if (!texts.length && !replyTexts.length && !tools.length && !progress.length) continue;
      const msg: HistoryMessage = { seq, ts, role: "assistant", text: texts.join("\n") };
      if (progress.length) msg.progress = progress.join("\n");
      if (replyTexts.length) msg.replyText = replyTexts.join("\n");
      if (replyComponents.length) msg.replyComponents = replyComponents;
      Object.assign(msg, replyFiles.length ? { replyFiles } : {}, tools.length ? { tools } : {});
      if (typeof rec.message?.model === "string") msg.model = rec.message.model;
      for (const id of replyIds) replyById.set(id, msg);
      for (const b of content) {
        if (b?.type !== "tool_result") continue; // Codex 的 MCP 调用：结果和调用同一条
        settleToolCard(toolById.get(b.tool_use_id), b, rec);
        if (replyIds.includes(b.tool_use_id)) msg.replyAskId = askIdOfReplyResult(b) ?? msg.replyAskId;
      }
      all.push(msg, ...content.flatMap((b: any) => inbox.expand(toolById.get(b?.tool_use_id), b, seq, ts))); // Codex：结果和调用同一条
    }
  }

  return all;
}


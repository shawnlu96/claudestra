/**
 * v2.9+ 会话历史解析 —— 只读历史 API 的核心（存储设计 2026-07-10 owner 拍板：
 * 文件为权威源，不入库，历史走只读 API 现场解析 jsonl）。
 *
 * 数据源两处，目录布局刻意同构（session-archive.ts 落盘时保持镜像）：
 *   - live:    ~/.claude/projects/<slug>/<sessionId>.jsonl（+ <sessionId>/subagents/）
 *   - archive: ~/.claude-orchestrator/archive/<agent>/<sessionId>.jsonl（+ 同名目录 subagents/）
 * 因此「主 jsonl 路径去掉 .jsonl + /subagents/」对两边都成立。
 *
 * 性能权衡（v1）：readSessionHistory 每次全量逐行解析。几十 MB 的 jsonl 在 Bun
 * 下是百毫秒级，API 侧有 30 req/min 限流兜底；等 web UI 出现高频翻页需求再上
 * byte-offset 索引，不提前优化。
 */

import { existsSync, readdirSync, statSync } from "fs";
import { open as fsOpen } from "fs/promises";
import { join } from "path";
import { projectJsonlPath } from "./jsonl-cost.js";
import { ARCHIVE_ROOT } from "./session-archive.js";

export interface HistoryToolCall {
  name: string;
  summary: string;
  /** 完整入参详情（jsonl-watcher formatToolDetail 渲染，截断 4k）——
   *  web 工具卡点开展示。可选：老快照 / 未传 toolDetailFn 时缺省。 */
  detail?: string;
  /** 该次调用的 tool_result 带 is_error——web 把失败的工具卡标红。 */
  error?: boolean;
}

/** reply() 附带的交互组件（按钮/选单），点击回投 [button:id]/[select:id:v]。
 *  形状与 bridge NeutralMessage 的 components 对齐，历史里原样透传给前端渲染。 */
export type ReplyComponentRow =
  | { type: "buttons"; buttons: { id: string; label: string; style?: string; emoji?: string }[] }
  | { type: "select"; id: string; placeholder?: string; options: { label: string; value: string; description?: string }[] }
  | { type: "multiselect"; id: string; placeholder?: string; min?: number; max?: number; submitLabel?: string; options: { label: string; value: string; description?: string }[] };

export interface HistoryMessage {
  /** jsonl 行号（0-based），分页锚点，同一文件内稳定 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: HistoryToolCall[];
  /** reply() 工具的正文——发给用户的「最终回复」，与过程叙述 text 分开渲染 */
  replyText?: string;
  /** reply() 附带的按钮/选单——历史里也渲染（否则用户不在直播那刻就看不到按钮） */
  replyComponents?: ReplyComponentRow[];
  /** reply() 附带的出站附件文件名（basename;取回走 inbox 后缀匹配兜底） */
  replyFiles?: string[];
  /** 回合耗时 ms(system/turn_duration 回填)——只有正常收尾的回合才有 */
  turnMs?: number;
  /** compact 产生的摘要条目（不是真实用户输入） */
  compactSummary?: boolean;
  model?: string;
  /** 入站消息的发送者标签（<channel> 的 user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
}

/** MCP reply 工具名：mcp__<MCP_NAME>__reply（MCP_NAME 可配，按前后缀匹配）。 */
function isReplyTool(name: string): boolean {
  return name.startsWith("mcp__") && name.endsWith("__reply");
}

/** 去掉 ANSI 转义序列（local-command-stdout 里的 \x1b[1m 等，裸渲染是豆腐块）。 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** jsonl 里的 components 不可信——只放行结构完整的按钮行/选单行，其余丢弃。 */
function sanitizeComponents(raw: unknown): ReplyComponentRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyComponentRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.type === "buttons" && Array.isArray(r.buttons)) {
      const buttons = r.buttons
        .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
        .filter((b) => typeof b.id === "string" && typeof b.label === "string")
        .map((b) => ({
          id: b.id as string,
          label: b.label as string,
          ...(typeof b.style === "string" ? { style: b.style } : {}),
          ...(typeof b.emoji === "string" ? { emoji: b.emoji } : {}),
        }));
      if (buttons.length) out.push({ type: "buttons", buttons });
    } else if ((r.type === "select" || r.type === "multiselect") && typeof r.id === "string" && Array.isArray(r.options)) {
      const options = r.options
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .filter((o) => typeof o.label === "string" && typeof o.value === "string")
        .map((o) => ({
          label: o.label as string,
          value: o.value as string,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        }));
      if (options.length) {
        // v2.14+ multiselect 与 select 同构，只多 min/max/submitLabel 三个可选字段。
        // ⚠ 这里漏认一种类型的后果不是「样式不对」而是**整组交互从历史里消失**——
        // 刷新页面后按钮就没了（owner 2026-07-25 实报「哪有多选按钮」）。
        out.push({
          type: r.type as "select" | "multiselect",
          id: r.id,
          ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
          ...(r.type === "multiselect" && typeof r.min === "number" ? { min: r.min } : {}),
          ...(r.type === "multiselect" && typeof r.max === "number" ? { max: r.max } : {}),
          ...(r.type === "multiselect" && typeof r.submitLabel === "string"
            ? { submitLabel: r.submitLabel }
            : {}),
          options,
        });
      }
    }
  }
  return out;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  /** 文件内可显示消息总数（不含被过滤的 meta/tool_result 载荷） */
  total: number;
  /** messages[0].seq 之前还有更早的消息（用 before=该 seq 翻上一页） */
  hasMore: boolean;
}

export interface SessionSummary {
  sessionId: string;
  /** 读取来源：live = CC projects 原文件（更全时优先），archive = 退役快照 */
  source: "live" | "archive";
  /** 服务器本地绝对路径 —— API 响应里不要外泄，仅供内部继续读文件 */
  path: string;
  sizeBytes: number;
  mtime: string;
  createdAt: string | null;
  subagents: string[];
}

// sessionId / subagent 参数会拼进文件路径，白名单校验防穿越
const SESSION_ID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
const SUBAGENT_RE = /^agent-[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(s: string): boolean {
  return SESSION_ID_RE.test(s);
}

export function isValidSubagentId(s: string): boolean {
  return SUBAGENT_RE.test(s);
}

/** 主 jsonl 旁的 subagent 会话 id 列表（live / archive 布局同构，统一适用） */
export function listSubagentFiles(mainJsonlPath: string): string[] {
  const dir = join(mainJsonlPath.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// channel 送达的入站消息在 CC jsonl 里落成 isMeta:true + "<channel …>…</channel>"
// 包装的 user 记录（CC channel 协议原生格式）。这是真实对话输入（web/API 用户、
// Discord 用户、agent↔agent），不解包的话历史 API 里看不到任何用户消息，web 端
// 回合结构也随之丢失（连续 assistant 记录跨回合粘连成巨型气泡）。
const CHANNEL_WRAP_RE = /^\s*<channel\s+([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/channel>\s*$/;

/**
 * 剥掉 bridge renderContentForLocal 注入的 framing header：正文开头的
 * [🌐 …] / [🤖 …] 方括号块是给 agent 的路由/行为指示，不是用户输入。header 内可能
 * 出现 "]"（如 [DIRECT] 标记），所以用 "]\n\n" 或行尾 "]" + 空行做块边界，而不是
 * 第一个 "]"。没匹配到已知 emoji 开头就原样保留（不误伤以 [ 开头的真实输入）。
 */
function stripChannelHeader(body: string): string {
  if (!/^\[(🌐|🤖|📢|📣)/.test(body)) return body;
  // header 块与正文用空行分隔——兼容 LF 与 CRLF（L7：CRLF jsonl 下 "]\n\n" 匹配不到
  // 会把 framing 头留在正文）。仍要求"]"+空行做边界，不用单个换行（正文里可能出现
  // "]\n"，会误切）。
  const m = body.match(/]\r?\n\r?\n/);
  if (!m || m.index === undefined) return body;
  return body.slice(m.index + m[0].length).trim();
}

/**
 * 解包一条 <channel> 入站消息：返回 { text, from }；不是 channel 包装
 * （caveat / local-command 等真 meta）返回 null。
 */
export function unwrapChannelMessage(raw: string): { text: string; from?: string } | null {
  const m = raw.match(CHANNEL_WRAP_RE);
  if (!m) return null;
  const from = /(?:^|\s)user="([^"]*)"/.exec(m[1])?.[1] || undefined;
  const text = stripChannelHeader(m[2].trim()).trim();
  if (!text) return null;
  return { text, from };
}

function summarize(sessionId: string, source: "live" | "archive", path: string): SessionSummary | null {
  try {
    const st = statSync(path);
    const birth = st.birthtime?.getTime?.() ? st.birthtime.toISOString() : null;
    return {
      sessionId,
      source,
      path,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
      createdAt: birth,
      subagents: listSubagentFiles(path),
    };
  } catch {
    return null;
  }
}

/**
 * 一个 agent 的全部可读 session：归档目录打底 + live 覆盖。
 *
 * live 覆盖两种情况：当前活 session（registry sessionId），以及归档过但 CC 侧
 * 源文件还在且不小于归档（copy-if-larger 语义 → 更大 = 更全）。刻意不扫
 * projects/<slug>/ 下的其他 jsonl —— 同 cwd 可能有用户手动开的无关会话，
 * agent 的 session 清单以「归档目录 + registry 当前值」为权威边界。
 */
export async function listAgentSessions(
  agentName: string,
  opts: {
    cwd?: string;
    currentSessionId?: string;
    archiveRoot?: string;
    /** 测试注入：live 路径推导，默认 projectJsonlPath */
    livePathFor?: (cwd: string, sessionId: string) => string;
  } = {},
): Promise<SessionSummary[]> {
  const livePathFor = opts.livePathFor ?? projectJsonlPath;
  const byId = new Map<string, SessionSummary>();

  const archiveDir = join(opts.archiveRoot ?? ARCHIVE_ROOT, agentName);
  if (existsSync(archiveDir)) {
    try {
      for (const f of readdirSync(archiveDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const sid = f.replace(/\.jsonl$/, "");
        const s = summarize(sid, "archive", join(archiveDir, f));
        if (s) byId.set(sid, s);
      }
    } catch { /* best-effort */ }
  }

  if (opts.cwd) {
    const candidates = new Set(byId.keys());
    if (opts.currentSessionId) candidates.add(opts.currentSessionId);
    for (const sid of candidates) {
      const lp = livePathFor(opts.cwd, sid);
      if (!existsSync(lp)) continue;
      const live = summarize(sid, "live", lp);
      if (!live) continue;
      const prev = byId.get(sid);
      if (!prev || live.sizeBytes >= prev.sizeBytes) byId.set(sid, live);
    }
  }

  return [...byId.values()].sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * 解析一个会话 jsonl 为中性消息页（transport / 前端无关）。
 *
 * 过滤规则：isMeta 条目、纯 tool_result 载荷的 user 条目、空 assistant 条目
 * 不进历史；compact_boundary 渲染成一条 system 分隔线；isCompactSummary 的
 * user 条目保留全文并打标（web UI 可折叠展示）。
 *
 * 分页语义（聊天视图习惯）：默认返回最尾部 limit 条；传 before=<seq> 拿更早
 * 的一页；hasMore 指「本页之前还有没有」。
 */
export async function readSessionHistory(
  filePath: string,
  opts: {
    limit?: number;
    before?: number;
    /** tool_use 摘要渲染器（bridge 传 jsonl-watcher 的 formatTool），默认只回工具名 */
    formatToolFn?: (name: string, input: any) => string;
    /** tool_use 完整详情渲染器（formatToolDetail）——省略则历史不带 detail */
    toolDetailFn?: (name: string, input: any) => string;
  } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const fmt = opts.formatToolFn ?? ((name: string) => name);
  const detailFn = opts.toolDetailFn;
  const raw = await Bun.file(filePath).text();
  const lines = raw.split("\n");
  const all: HistoryMessage[] = [];
  // tool_use id → 工具卡：后续 user 记录里的 tool_result(is_error) 回填失败态
  const toolById = new Map<string, HistoryToolCall>();

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      // 纯文本不带装饰——system 条目的分隔线样式由各前端自己渲染
      all.push({ seq: i, ts, role: "system", text: "上下文已压缩（compact）" });
      continue;
    }

    // turn_duration → 回填到刚结束的那轮 assistant 的 turnMs。
    // 只有正常收尾的回合才有这条(被打断的没有),前端据此给历史尾轮
    // 渲染「✓ 完成 · 12.3s」——切后台错过 done 事件后刷新也能看到完成态。
    if (rec.type === "system" && rec.subtype === "turn_duration" && typeof rec.durationMs === "number") {
      for (let j = all.length - 1; j >= 0; j--) {
        if (all[j].role === "assistant") {
          all[j].turnMs = rec.durationMs;
          break;
        }
        if (all[j].role === "user") break; // 中间隔了用户消息就不回填
      }
      continue;
    }

    if (rec.type === "user") {
      const c = rec.message?.content;
      // tool_result 的 is_error 回填到对应工具卡（web 标红失败的调用）。
      // 回填不影响本条 user 记录自身的过滤逻辑，继续走原流程。
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "tool_result" && b.tool_use_id && b.is_error === true) {
            const tc = toolById.get(b.tool_use_id);
            if (tc) tc.error = true;
          }
        }
      }
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n")
            : "";
      if (rec.isMeta === true) {
        // isMeta + <channel> 包装 = channel 送达的真实入站消息，解包进历史；
        // 其余 isMeta（caveat / local-command 输出等）照旧过滤
        const un = unwrapChannelMessage(text);
        if (!un) continue;
        // bridge 内部注入(看门狗 nudge 等管线提示,user="bridge:*")不进
        // 历史——那是发给 agent 的指令,不是对话。直播侧 srcKind 过滤已同款
        // 排除,历史侧对齐(2026-07-24 用户截图:nudge 全文以用户气泡出现在
        // migration 历史里,像系统故障)。
        if (un.from && /^bridge(:|$)/.test(un.from)) continue;
        const msg: HistoryMessage = { seq: i, ts, role: "user", text: un.text };
        if (un.from) msg.from = un.from;
        all.push(msg);
        continue;
      }
      if (!text.trim()) continue; // 纯 tool_result 载荷
      // TUI 斜杠命令记录（不带 isMeta 的裸 user 条目）不是用户打的字：
      //   <command-name>/x</command-name> ± <command-message>…（顺序不定）→ system 轻条目「/x」
      //   <local-command-stdout>输出</local-command-stdout> → system 轻条目（去 ANSI、截断）
      // 不处理会把原始标签 + ANSI 转义裸渲染成用户气泡（2026-07-12 真机截图）。
      const trimmed = text.trim();
      // harness 注入的后台任务完成通知(<task-notification>,裸 user 记录
      // 不带 isMeta)不是用户打的字——渲染成用户气泡就像「用户发了段 XML」
      // (2026-07-14 真机截图,master 频道)。取 summary 转 system 轻条目。
      if (/^<task-notification>/.test(trimmed)) {
        const sum = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed);
        const body = sum?.[1]?.trim();
        all.push({ seq: i, ts, role: "system", text: body ? `⚙️ ${body}` : "⚙️ 后台任务通知" });
        continue;
      }
      if (/^<command-(name|message)>/.test(trimmed)) {
        const cmd = /<command-name>(\/[\w:-]+)<\/command-name>/.exec(trimmed);
        if (cmd) all.push({ seq: i, ts, role: "system", text: cmd[1] });
        continue; // 无 command-name 的畸形命令记录直接丢
      }
      const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(trimmed);
      if (stdout) {
        const body = stripAnsi(stdout[1]).trim();
        if (!body || body === "(no content)") continue;
        all.push({ seq: i, ts, role: "system", text: body.length > 200 ? body.slice(0, 200) + "…" : body });
        continue;
      }
      // 队列回放的裸斜杠命令：tmux 注入的 /compact 等经 CC 队列会额外落一条
      // 纯文本 user 记录，紧接着还有 <command-name> 记录 → 不跳过就同一命令渲染成
      // 「用户气泡 + 分隔条」双份（2026-07-13）。channel 入站消息是 isMeta 包装，
      // TUI 直敲的合法命令只落 <command-name> 记录，都不走这条路径。
      if (/^\/[\w:-]+$/.test(trimmed)) continue;
      const msg: HistoryMessage = { seq: i, ts, role: "user", text };
      if (rec.isCompactSummary === true) msg.compactSummary = true;
      all.push(msg);
      continue;
    }

    if (rec.type === "assistant") {
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      const replyTexts: string[] = [];
      const replyComponents: ReplyComponentRow[] = [];
      const replyFiles: string[] = [];
      const tools: HistoryToolCall[] = [];
      for (const b of content) {
        if (b?.type === "text" && b.text?.trim()) texts.push(b.text);
        else if (b?.type === "tool_use" && b.name) {
          // reply() 的正文是「发给用户的消息」，不是工具动作——提取成文本，别当
          // 工具卡（否则 formatTool 只剩「🔧 <server>/reply」，回复内容在历史里蒸发，
          // 直播能看到、进历史就没了）。这样历史与直播都渲染同一份 reply。
          if (isReplyTool(b.name) && typeof b.input?.text === "string" && b.input.text.trim()) {
            replyTexts.push(b.input.text);
            // reply 附带的按钮/选单也进历史（否则用户不在直播那刻就看不到按钮）
            replyComponents.push(...sanitizeComponents(b.input?.components));
            // 出站附件（agent 发给用户的图/文件）：jsonl 里是绝对路径,取 basename
            // ——bridge 投递时已拷贝到 inbox（时间戳前缀）,取回走后缀匹配兜底
            if (Array.isArray(b.input?.files)) {
              for (const f of b.input.files) {
                if (typeof f === "string" && f.trim()) {
                  const base = f.trim().split("/").pop();
                  if (base) replyFiles.push(base);
                }
              }
            }
          } else {
            const tc: HistoryToolCall = { name: b.name, summary: fmt(b.name, b.input) };
            if (detailFn) {
              const dt = detailFn(b.name, b.input);
              if (dt) tc.detail = dt;
            }
            tools.push(tc);
            if (typeof b.id === "string" && b.id) toolById.set(b.id, tc);
          }
        }
      }
      if (!texts.length && !replyTexts.length && !tools.length) continue;
      const msg: HistoryMessage = { seq: i, ts, role: "assistant", text: texts.join("\n") };
      if (replyTexts.length) msg.replyText = replyTexts.join("\n");
      if (replyComponents.length) msg.replyComponents = replyComponents;
      if (replyFiles.length) msg.replyFiles = replyFiles;
      if (tools.length) msg.tools = tools;
      if (typeof rec.message?.model === "string") msg.model = rec.message.model;
      all.push(msg);
    }
  }

  const eligible = opts.before != null ? all.filter((m) => m.seq < opts.before!) : all;
  const messages = eligible.slice(-limit);
  return { messages, total: all.length, hasMore: eligible.length > messages.length };
}

// ── 聊天记录全文搜索 ─────────────────────────────────────────────

export interface HistorySearchHit {
  /** jsonl 行号，与 readSessionHistory 的 seq 同一坐标系 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant";
  /** 命中消息的正文节选（命中词居中，前 80 后 240 字符，越界加 …） */
  snippet: string;
  /** 入站消息发送者（<channel> user 属性） */
  from?: string;
  /** 命中在 compact 压缩摘要里——被 compact 抛弃的上下文正是搜索的高价值目标 */
  compact?: boolean;
}

/** 命中词居中截取节选。 */
function makeSnippet(text: string, lowerText: string, q: string): string {
  const at = lowerText.indexOf(q);
  const start = Math.max(0, at - 80);
  const end = Math.min(text.length, at + q.length + 240);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * 在一个会话 jsonl 里全文搜索对话正文（user 文本 / assistant 叙述 / reply 正文 /
 * compact 摘要）。工具参数与 tool_result 不搜——用户「模糊记得一件事」的场景
 * 命中点在对话正文，参数级噪音只会淹没结果。
 *
 * 性能：先对原始行做大小写不敏感子串预筛（indexOf），命中才 JSON.parse +
 * 正文提取 + 二次确认（预筛可能命中在工具参数/JSON key 上）。53MB 的 jsonl
 * 预筛一遍远快于全量 parse。
 */
export async function searchSessionHistory(
  filePath: string,
  query: string,
  opts: { maxHits?: number; maxFullScanBytes?: number } = {},
): Promise<HistorySearchHit[]> {
  const maxHits = Math.max(1, Math.min(100, Math.floor(opts.maxHits ?? 20)));
  const q = query.toLowerCase();
  if (!q) return [];
  // 体积闸：本函数会同时持有 raw / lowerRaw / lines / lowerLines 四份数据，峰值
  // 约等于文件大小的 4 倍；而调用方（GET /history/search）是 6 路并发扫遍每个
  // agent 的 live + 归档会话。本机最大的 session jsonl 已经 96MB，一次点击就能
  // 把 bridge 推到 GB 级峰值。超过阈值的文件只扫尾部 —— 搜索本就是找最近说过
  // 什么，越老的内容越不需要全文命中。
  const MAX_FULL_SCAN_BYTES = opts.maxFullScanBytes ?? 16 * 1024 * 1024;
  const _f = Bun.file(filePath);
  const _size = _f.size;
  // ⚠ seq 是「全文件行号」,与 readSessionHistory 同坐标系——搜索跳转按它开历史
  // 窗口。只扫尾部时行号从切片起点重数就整体错位(2026-07-27 跳转实测),必须先
  // 数出被跳过前缀里的换行数作基准。fs 句柄 + 8MB 复用缓冲循环读(Buffer.indexOf
  // 是 memchr 级),百 MB 前缀几十 ms、零大字符串。⚠ 不要用 Blob.slice().stream()
  // ——实测在 100MB 级文件上病理性慢(2min+ 不返回)。前缀最后一个不完整行与尾片
  // 首行拼成同一行,行号恰为 lineOffset,该行 JSON.parse 必失败被跳过,坐标无损。
  let lineOffset = 0;
  let raw: string;
  if (_size > MAX_FULL_SCAN_BYTES) {
    const cut = _size - MAX_FULL_SCAN_BYTES;
    const fh = await fsOpen(filePath, "r");
    try {
      const buf = Buffer.alloc(8 * 1024 * 1024);
      let pos = 0;
      while (pos < cut) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, cut - pos), pos);
        if (bytesRead <= 0) break;
        let at = -1;
        const view = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
        while ((at = view.indexOf(10, at + 1)) !== -1) lineOffset++;
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    raw = await _f.slice(cut).text();
  } else {
    raw = await _f.text();
  }
  // 性能梯次（2026-07-14 owner:「先把免费优化做了」）：
  // ① 文件级预筛——整个文件不含词直接出局，多数归档文件在这里零解析返回；
  // ② 单次 toLowerCase——53MB 文件逐行 toLowerCase 是 10 万次小分配 + GC 压力，
  //    整体一次快得多。\n 无大小写形态，两个 split 的行号严格对齐（个别 Unicode
  //    字符 lower 后长度会变，但只影响行内 offset，不影响行对齐与 includes 判断）。
  const lowerRaw = raw.toLowerCase();
  if (!lowerRaw.includes(q)) return [];
  const lines = raw.split("\n");
  const lowerLines = lowerRaw.split("\n");
  const hits: HistorySearchHit[] = [];

  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const line = lines[i];
    if (!line.trim() || !lowerLines[i].includes(q)) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    if (rec.type === "user") {
      const c = rec.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n")
            : "";
      let body = text;
      let from: string | undefined;
      if (rec.isMeta === true) {
        // channel 送达的入站消息解包；其余 isMeta（caveat / 命令输出）不搜
        const un = unwrapChannelMessage(text);
        if (!un) continue;
        if (un.from && /^bridge(:|$)/.test(un.from)) continue; // bridge 注入不搜(同历史过滤)
        body = un.text;
        from = un.from;
      } else {
        const trimmed = text.trim();
        // 与 readSessionHistory 同规则：机器产物不当用户消息搜
        if (!trimmed) continue;
        if (/^<(task-notification|command-name|command-message|local-command-stdout)>/.test(trimmed)) continue;
        if (/^\/[\w:-]+$/.test(trimmed)) continue;
      }
      const lower = body.toLowerCase();
      if (!lower.includes(q)) continue;
      const hit: HistorySearchHit = { seq: lineOffset + i, ts, role: "user", snippet: makeSnippet(body, lower, q) };
      if (from) hit.from = from;
      if (rec.isCompactSummary === true) hit.compact = true;
      hits.push(hit);
      continue;
    }

    if (rec.type === "assistant") {
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const parts: string[] = [];
      for (const b of content) {
        if (b?.type === "text" && b.text?.trim()) parts.push(b.text);
        else if (b?.type === "tool_use" && b.name && isReplyTool(b.name) && typeof b.input?.text === "string") {
          parts.push(b.input.text);
        }
      }
      if (!parts.length) continue;
      const body = parts.join("\n");
      const lower = body.toLowerCase();
      if (!lower.includes(q)) continue;
      hits.push({ seq: lineOffset + i, ts, role: "assistant", snippet: makeSnippet(body, lower, q) });
    }
  }
  return hits;
}

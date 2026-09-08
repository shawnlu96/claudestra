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
import { projectJsonlPath, findJsonlBySessionId } from "./jsonl-cost.js";
import { ARCHIVE_ROOT } from "./session-archive.js";

/** 超过此字节数的 session jsonl 走尾读(见 readSessionHistory)。与搜索同阈值。 */
const MAX_HISTORY_FULL_READ_BYTES = 16 * 1024 * 1024;

/**
 * 数出 [0, cut) 字节里的换行数 —— 尾读时把 seq 校正回「全文件行号」。
 * fs 句柄 + 8MB 复用缓冲循环 Buffer.indexOf(10)(memchr 级),百 MB 前缀几十毫秒、
 * 零大字符串。⚠ 不要用 Blob.slice().stream()(searchSessionHistory 实测 100MB 级
 * 病理性慢,2min+ 不返回)。
 */
/**
 * v2.21.4 换行计数检查点缓存(「正在同步消息」慢的主因之一,owner 2026-09-06):
 * 尾读要知道窗口前缀有多少行(seq 坐标),原先每次请求从头扫到 cut——70MB 的会话
 * 每次差量都扫 54MB(≈300ms 同步阻塞 Bun 主线程)。jsonl 追加写、前缀不变:按 1MB
 * 边界记「字节 → 换行数」检查点,之后只扫最近检查点到 cut 的那一小段。每个检查点带
 * 32 字节内容签名,文件被重写(CC 原地更新记录 / 归档替换 / 截短)时签名不符即作废
 * 该点及其后所有点,不会算错 seq。最多缓存 64 个文件(先进先出)。
 */
const NL_STEP = 1 << 20;
const NL_SIG_LEN = 32;
interface NlCkpt { b: number; n: number; sig: string }
const nlIndex = new Map<string, NlCkpt[]>();

async function countNewlinesBefore(filePath: string, cut: number): Promise<number> {
  if (cut <= 0) return 0;
  const fh = await fsOpen(filePath, "r");
  try {
    let pts = nlIndex.get(filePath);
    if (!pts) {
      pts = [];
      if (nlIndex.size >= 64) nlIndex.delete(nlIndex.keys().next().value as string);
      nlIndex.set(filePath, pts);
    }
    const sigBuf = Buffer.alloc(NL_SIG_LEN);
    const readSig = async (at: number): Promise<string | null> => {
      const { bytesRead } = await fh.read(sigBuf, 0, NL_SIG_LEN, at);
      return bytesRead === NL_SIG_LEN ? sigBuf.toString("latin1") : null;
    };
    // 从最后一个 ≤cut 且签名仍匹配的检查点起算;签名不符 → 该点及其后全部作废
    let startB = 0;
    let n = 0;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].b > cut) continue;
      if ((await readSig(pts[i].b)) === pts[i].sig) {
        startB = pts[i].b;
        n = pts[i].n;
        break;
      }
      pts.length = i;
    }
    const buf = Buffer.alloc(NL_STEP);
    let pos = startB;
    while (pos < cut) {
      const want = Math.min(cut, (Math.floor(pos / NL_STEP) + 1) * NL_STEP) - pos;
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, pos + got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      const view = buf.subarray(0, got);
      let at = -1;
      while ((at = view.indexOf(10, at + 1)) !== -1) n++;
      pos += got;
      if (got < want) break; // 文件比 cut 短(并发截短):到此为止
      if (pos % NL_STEP === 0 && (pts.length === 0 || pts[pts.length - 1].b < pos)) {
        const sig = await readSig(pos);
        if (sig !== null) pts.push({ b: pos, n, sig });
      }
    }
    return n;
  } finally {
    await fh.close();
  }
}

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
  /**
   * v2.21.3+ 进度句(💭):Fable 5.1 的 progress-update thinking 块——「接下来我会…」
   * 这类给用户看的短注,不是推理正文。与 text 分开:渲染更弱、不进 content 对账。
   */
  progress?: string;
  model?: string;
  /** 入站消息的发送者标签（<channel> 的 user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
}

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
      let lp = livePathFor(opts.cwd, sid);
      // v2.16.1 slug 失配兜底(2026-08-02 peer 实锤:slug 规则偏差会让 live
      // session 整体失明,web 历史停在旧归档):路径推导 miss 就按 sessionId
      // 全局扫 projects 目录——live 会话绝不因 slug 推导错误而不可见。
      if (!existsSync(lp)) {
        const found = findJsonlBySessionId(sid);
        if (!found) continue;
        lp = found;
      }
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
    /** 差量同步:只取 seq > after 的消息(唤醒追平用,与 before 互斥) */
    after?: number;
    /** tool_use 摘要渲染器（bridge 传 jsonl-watcher 的 formatTool），默认只回工具名 */
    formatToolFn?: (name: string, input: any) => string;
    /** tool_use 完整详情渲染器（formatToolDetail）——省略则历史不带 detail */
    toolDetailFn?: (name: string, input: any) => string;
    /** 超过此字节走尾读(默认 16MB);单测可调低来在小 fixture 上验尾读路径 */
    maxFullReadBytes?: number;
  } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const fmt = opts.formatToolFn ?? ((name: string) => name);
  const detailFn = opts.toolDetailFn;
  const before = opts.before;
  const after = opts.after;
  const maxFull = opts.maxFullReadBytes ?? MAX_HISTORY_FULL_READ_BYTES;

  const f = Bun.file(filePath);
  const size = f.size;

  // 小文件:一次全读,total 精确。单测与绝大多数会话走这条,行为与 v1 完全一致。
  if (size <= maxFull) {
    const all = parseHistoryLines((await f.text()).split("\n"), 0, fmt, detailFn);
    return sliceHistoryPage(all, limit, before, after, all.length, false);
  }

  // 大文件:尾读加宽(2026-08-23 perf 根因,见文件头注释)。原先无条件全文读 +
  // 逐行 JSON.parse,232MB≈1.3s 同步阻塞 Bun 主线程,期间所有请求排队、SSE 心跳
  // 都发不出 → 手机端撞穿 BFF 8s/10s 超时 → 502 → 差量游标卡死「正在同步但永不
  // 更新」。差量 after= 每次重连都发、原先照样全文读,是这个 bug 的真凶。
  // 高频路径(默认页 / 差量)只需文件尾部,基本一窗命中;before 往回翻页从尾部
  // 反向扩窗直到够一页。贫路径(极深翻页)最坏读到全文,与 v1 持平。
  // 差量(after=)只要锚点之后的几条,首窗 1MB 够用(不够再 ×8);默认页 / 翻页仍 8MB
  let win = after != null ? 1024 * 1024 : 8 * 1024 * 1024;
  for (;;) {
    const cut = Math.max(0, size - win);
    const reachedStart = cut === 0;
    const lineOffset = await countNewlinesBefore(filePath, cut);
    const all = parseHistoryLines((await f.slice(cut).text()).split("\n"), lineOffset, fmt, detailFn);

    let satisfied = reachedStart;
    if (!satisfied) {
      if (after != null) {
        // 差量:窗口必须回读到锚点行(首行号 <= after),才拿得到完整的 seq>after 集合
        satisfied = lineOffset <= after;
      } else if (before != null) {
        satisfied = all.filter((m) => m.seq < before).length >= limit;
      } else {
        satisfied = all.length >= limit;
      }
    }
    if (satisfied || reachedStart) {
      return sliceHistoryPage(all, limit, before, after, all.length, !reachedStart);
    }
    win *= 8;
  }
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
function parseHistoryLines(
  lines: string[],
  lineOffset: number,
  fmt: (name: string, input: any) => string,
  detailFn: ((name: string, input: any) => string) | undefined,
): HistoryMessage[] {
  const all: HistoryMessage[] = [];
  // tool_use id → 工具卡：后续 user 记录里的 tool_result(is_error) 回填失败态
  const toolById = new Map<string, HistoryToolCall>();
  // v2.21.4 队列附件去重:同一条入站消息若另有 user(isMeta) 记录,以 user 记录为准
  const seenChannelIds = collectChannelMessageIds(lines);

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const seq = lineOffset + i;
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      // 纯文本不带装饰——system 条目的分隔线样式由各前端自己渲染
      all.push({ seq, ts, role: "system", text: "上下文已压缩（compact）" });
      continue;
    }

    if (rec.type === "attachment") {
      // v2.21.4 被队列吸收的入站消息:agent 忙时 channel 送达的消息先进 CC 队列,随后
      // 「absorbed_mid_turn」并入当前回合——jsonl 里只落 attachment(queued_command,
      // commandMode=prompt),**没有** user 记录。不解析,历史就缺这条用户消息,web 的
      // 乐观气泡对不上账,30 分钟内每次对齐都被接回列表尾(owner 2026-09-04 截图
      // 「很久之前发的老消息总显示在最下面」)。commandMode=task-notification 是
      // harness 的后台任务通知,不进历史。
      const queued = queuedPromptOf(rec);
      if (queued) {
        const un = unwrapChannelMessage(queued);
        if (un && !(un.from && /^bridge(:|$)/.test(un.from))) {
          const mid = channelMessageId(queued);
          if (!mid || !seenChannelIds.has(mid)) {
            const msg: HistoryMessage = { seq, ts, role: "user", text: un.text };
            if (un.from) msg.from = un.from;
            all.push(msg);
          }
        }
      }
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
        const msg: HistoryMessage = { seq, ts, role: "user", text: un.text };
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
        all.push({ seq, ts, role: "system", text: body ? `⚙️ ${body}` : "⚙️ 后台任务通知" });
        continue;
      }
      if (/^<command-(name|message)>/.test(trimmed)) {
        const cmd = /<command-name>(\/[\w:-]+)<\/command-name>/.exec(trimmed);
        if (cmd) all.push({ seq, ts, role: "system", text: cmd[1] });
        continue; // 无 command-name 的畸形命令记录直接丢
      }
      const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(trimmed);
      if (stdout) {
        const body = stripAnsi(stdout[1]).trim();
        if (!body || body === "(no content)") continue;
        all.push({ seq, ts, role: "system", text: body.length > 200 ? body.slice(0, 200) + "…" : body });
        continue;
      }
      // 队列回放的裸斜杠命令：tmux 注入的 /compact 等经 CC 队列会额外落一条
      // 纯文本 user 记录，紧接着还有 <command-name> 记录 → 不跳过就同一命令渲染成
      // 「用户气泡 + 分隔条」双份（2026-07-13）。channel 入站消息是 isMeta 包装，
      // TUI 直敲的合法命令只落 <command-name> 记录，都不走这条路径。
      if (/^\/[\w:-]+$/.test(trimmed)) continue;
      const msg: HistoryMessage = { seq, ts, role: "user", text };
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
      if (!texts.length && !replyTexts.length && !tools.length && !progress.length) continue;
      const msg: HistoryMessage = { seq, ts, role: "assistant", text: texts.join("\n") };
      if (progress.length) msg.progress = progress.join("\n");
      if (replyTexts.length) msg.replyText = replyTexts.join("\n");
      if (replyComponents.length) msg.replyComponents = replyComponents;
      if (replyFiles.length) msg.replyFiles = replyFiles;
      if (tools.length) msg.tools = tools;
      if (typeof rec.message?.model === "string") msg.model = rec.message.model;
      all.push(msg);
    }
  }

  return all;
}

/** 从解析好的(全量或尾窗)消息里按 before/after/默认切页。after 与 before 互斥,
 *  after 优先。moreBefore=尾读且未读到文件头时为真(窗口之前还有更早消息)。 */
function sliceHistoryPage(
  all: HistoryMessage[],
  limit: number,
  before: number | undefined,
  after: number | undefined,
  total: number,
  moreBefore: boolean,
): HistoryPage {
  if (after != null) {
    const later = all.filter((m) => m.seq > after);
    const messages = later.slice(0, limit);
    return { messages, total, hasMore: later.length > messages.length };
  }
  const eligible = before != null ? all.filter((m) => m.seq < before) : all;
  const messages = eligible.slice(-limit);
  return { messages, total, hasMore: moreBefore || eligible.length > messages.length };
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
/** 流式 grep:按固定 chunk 读文件,只产出小写后含 q 的整行及其全文件行号(见 searchSessionHistory 注释)。 */
/** ASCII 大写折小写(字节级)。非 ASCII 字节(≥0x80)原样返回——UTF-8 自同步,子串搜索无误配。 */
function foldByte(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** 英文字母出现频率(%),用来挑锚点字节——锚点越稀有,memchr 给出的候选越少。
 *  非 ASCII 字节按 0.5 估(本语料以 ASCII 为主,CJK 字节相对稀有)。 */
const LETTER_FREQ: Record<string, number> = {
  e: 12, t: 9, a: 8, o: 7.5, i: 7, n: 6.7, s: 6.3, h: 6, r: 6, d: 4.3, l: 4,
  c: 2.8, u: 2.8, m: 2.4, w: 2.4, f: 2.2, g: 2, y: 2, p: 1.9, b: 1.5, v: 1,
  k: 0.8, j: 0.15, x: 0.15, q: 0.1, z: 0.07,
};

/** needle 里最稀有的那个字节的下标(见 LETTER_FREQ)。 */
function anchorIndex(needle: Buffer): number {
  let best = 0;
  let bestFreq = Infinity;
  for (let i = 0; i < needle.length; i++) {
    const b = needle[i];
    const f = b > 127 ? 0.5 : LETTER_FREQ[String.fromCharCode(b)] ?? 0.3;
    if (f < bestFreq) {
      bestFreq = f;
      best = i;
    }
  }
  return best;
}

/**
 * 在 buf 里找 needle(已小写)的首个位置,ASCII 不区分大小写;没有返回 -1。
 * 锚点取 needle 里最稀有的字节(不是首字节):用 Buffer.indexOf(锚点的大小写两形)
 * 走 memchr 定位候选,再逐字节折叠校验。两个游标各自惰性推进——每个候选只付一次
 * indexOf,而不是每轮两次(2026-09-08 实测 255MB 文件搜 "aston" 709ms→227ms:
 * 首字节 'a' 太常见,换成 's' 且减半 indexOf 调用是这里的全部收益)。
 */
function findFolded(buf: Buffer, needle: Buffer, ai: number, from = 0): number {
  const n = needle.length;
  const limit = buf.length - n;
  if (n === 0 || limit < 0 || from > limit) return -1;
  const lo = needle[ai];
  const hi = lo >= 97 && lo <= 122 ? lo - 32 : lo;
  let ia = buf.indexOf(lo, from + ai);
  let ib = hi === lo ? -1 : buf.indexOf(hi, from + ai);
  while (ia >= 0 || ib >= 0) {
    const useA = ib < 0 || (ia >= 0 && ia < ib);
    const at = useA ? ia : ib;
    const p = at - ai;
    if (p > limit) return -1;
    if (p >= from) {
      let k = 0;
      for (; k < n; k++) if (foldByte(buf[p + k]) !== needle[k]) break;
      if (k === n) return p;
    }
    if (useA) ia = buf.indexOf(lo, at + 1);
    else ib = buf.indexOf(hi, at + 1);
  }
  return -1;
}

/**
 * 流式 grep:按固定 chunk 读文件,只产出小写后含 q 的整行及其全文件行号
 * (见 searchSessionHistory 注释)。
 *
 * 两级都在字节上做(2026-09-08 二次优化,全库 764MB 一次搜索 6.2s→约 2s):
 * ① 块级预筛 findFolded,不含词的块只用 memchr 数换行,连字符串都不建;
 * ② 命中块也不整块解码——用 findFolded 逐个定位命中处,只把**命中所在的那一行**
 *    切出来解码,其余行连 toLowerCase 都不做(旧写法一命中就 split 整块 8MB
 *    再逐行小写,而一块里通常只有几行真的含词)。
 * 字节比较按 ASCII 折叠大小写:CJK / 数字 / 标点在大小写映射下不变,可安全走这条
 * 快路;查询里带**非 ASCII 且大小写会变**的字母(如 ö/Ö)时退回逐块 toLowerCase 的
 * 慢路,保证不漏。残留边角:İ(U+0130) 小写成 "i̇" 这类映射后才等于 ASCII 的字符,
 * 快路会漏——本语料里可忽略。
 */
async function* grepJsonlLines(
  filePath: string,
  q: string,
  chunkBytes = 8 * 1024 * 1024,
): AsyncGenerator<{ line: string; idx: number }> {
  const size = Math.max(64, Math.floor(chunkBytes));
  const needle = Buffer.from(q, "utf8");
  const ai = anchorIndex(needle);
  // 非 ASCII 部分大小写不变 → 字节比较可靠
  const nonAscii = [...q].filter((ch) => ch.charCodeAt(0) > 127).join("");
  const byteFast = nonAscii === nonAscii.toUpperCase() && nonAscii === nonAscii.toLowerCase();
  const fh = await fsOpen(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    let pos = 0;
    let lineIdx = 0; // 已数过的行数 = body 首行的全文件行号
    let carry: Buffer = Buffer.alloc(0); // 上一块末尾的半行(字节,不切开 UTF-8)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, size, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      const work = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const lastNl = work.lastIndexOf(10);
      if (lastNl < 0) {
        carry = Buffer.from(work); // buf 会被下轮覆写,必须拷贝
        continue;
      }
      const body = work.subarray(0, lastNl + 1);
      carry = Buffer.from(work.subarray(lastNl + 1));

      if (!byteFast) {
        // 慢路:非 ASCII 变形词,整块解码后逐行判定(正确性优先)
        const text = body.toString("utf8");
        if (text.toLowerCase().includes(q)) {
          const lines = text.split("\n"); // 末尾恒为 ""(body 以 \n 结尾)
          for (let i = 0; i < lines.length - 1; i++) {
            const l = lines[i];
            if (l.trim() && l.toLowerCase().includes(q)) yield { line: l, idx: lineIdx + i };
          }
          lineIdx += lines.length - 1;
        } else {
          let at = -1;
          while ((at = body.indexOf(10, at + 1)) !== -1) lineIdx++;
        }
        continue;
      }

      // 快路:先看整块有没有;有才逐个命中处切行。nlCur 恒为「已数过的最后一个
      // 换行之后」= 当前行的起点,nlSeen 是块内已数过的换行数。
      let nlSeen = 0;
      let nlCur = 0;
      const countUpTo = (p: number) => {
        for (;;) {
          const at = body.indexOf(10, nlCur);
          if (at === -1 || at >= p) return;
          nlSeen++;
          nlCur = at + 1;
        }
      };
      let from = 0;
      for (;;) {
        const p = findFolded(body, needle, ai, from);
        if (p < 0) break;
        countUpTo(p);
        const nl = body.indexOf(10, p);
        const lineEnd = nl === -1 ? body.length : nl;
        const line = body.subarray(nlCur, lineEnd).toString("utf8");
        if (line.trim() && line.toLowerCase().includes(q)) yield { line, idx: lineIdx + nlSeen };
        from = lineEnd + 1;
        if (from > body.length - needle.length) break;
      }
      // 收尾:数完本块剩余换行(body 以 \n 结尾 ⇒ nlSeen = 本块完整行数)
      for (;;) {
        const at = body.indexOf(10, nlCur);
        if (at === -1) break;
        nlSeen++;
        nlCur = at + 1;
      }
      lineIdx += nlSeen;
    }
    const tail = carry.toString("utf8");
    if (tail.trim() && tail.toLowerCase().includes(q)) yield { line: tail, idx: lineIdx };
  } finally {
    await fh.close();
  }
}

export async function searchSessionHistory(
  filePath: string,
  query: string,
  opts: { maxHits?: number; maxFullScanBytes?: number; chunkBytes?: number } = {},
): Promise<HistorySearchHit[]> {
  const maxHits = Math.max(1, Math.min(100, Math.floor(opts.maxHits ?? 20)));
  const q = query.toLowerCase();
  if (!q) return [];
  // 2026-09-08 起全文流式扫描(owner:「明明聊过 DB9,搜不出来」——gc-car 会话 243MB,
  // 旧实现超过 16MB 只扫尾部 16MB,7～9 月的讨论在 209～215MB 处永远搜不到)。
  // 旧实现一次持有 raw / lowerRaw / lines / lowerLines 四份 = 文件 4 倍内存,才不得
  // 不切尾;现在 fs 句柄 + 固定 chunk 循环读:每块先整体 toLowerCase 预筛,不含词的
  // 块只数换行(绝大多数块在此出局,零 split),含词的块才按行拆、逐行判定;跨块的
  // 半行以字节形式接到下一块开头(不在 UTF-8 中间切开)。峰值内存
  // ≈ 3×chunk,与文件大小无关;seq 仍是全文件行号(搜索跳转按它开历史窗口)。
  // opts.maxFullScanBytes 已无意义,保留只为兼容旧调用方。
  const hits: HistorySearchHit[] = [];

  for await (const { line, idx } of grepJsonlLines(filePath, q, opts.chunkBytes)) {
    if (hits.length >= maxHits) break;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    // v2.21.4 被队列吸收的入站消息(attachment queued_command/prompt)与历史同规则可搜
    const queued = rec.type === "attachment" ? queuedPromptOf(rec) : null;
    if (queued) {
      const un = unwrapChannelMessage(queued);
      if (!un || (un.from && /^bridge(:|$)/.test(un.from))) continue;
      const lower = un.text.toLowerCase();
      if (!lower.includes(q)) continue;
      const hit: HistorySearchHit = { seq: idx, ts, role: "user", snippet: makeSnippet(un.text, lower, q) };
      if (un.from) hit.from = un.from;
      hits.push(hit);
      continue;
    }

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
      const hit: HistorySearchHit = { seq: idx, ts, role: "user", snippet: makeSnippet(body, lower, q) };
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
      hits.push({ seq: idx, ts, role: "assistant", snippet: makeSnippet(body, lower, q) });
    }
  }
  return hits;
}

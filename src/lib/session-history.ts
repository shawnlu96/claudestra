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

import { findSessionJsonlBySessionId, runtimeForSessionPath, sessionJsonlPath, translateSessionLine } from "./session-source.js";
import { existsSync, readdirSync, statSync } from "fs";
import { open as fsOpen } from "fs/promises";
import { grepJsonlLines } from "./session-history-grep.js";
import { join } from "path";
import { projectJsonlPath, findJsonlBySessionId } from "./jsonl-cost.js";
import { agentArchiveDir, ARCHIVE_ROOT, realpathWithin } from "./session-archive.js";
import { ccOwnRecord, plainUserText, verifiedForeignRecord } from "./cc-own-records.js";
import type { InboundLookup } from "./inbound-ledger.js";

import { channelUserMessage, isReplyTool, parseHistoryLines, queuedPromptOf } from "./session-history-parse.js";
import type { HistoryMessage, HistoryPage, HistorySearchHit, SessionSummary } from "./session-history-types.js";

export { channelMessageId, isReplyTool, PROGRESS_NOTE_MAX_CHARS, progressNoteOf, queuedPromptOf, unwrapChannelMessage } from "./session-history-parse.js";
export type { HistoryMessage, HistoryPage, HistorySearchHit, HistoryToolCall, ReplyComponentRow, SessionSummary } from "./session-history-types.js";

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

export async function countNewlinesBefore(filePath: string, cut: number): Promise<number> {
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
    /** 测试注入：live 路径推导，默认按 runtime 选 Claude Code / Pi */
    livePathFor?: (cwd: string, sessionId: string) => string;
    /** v2.23+ 运行时：Pi 的会话文件在 ~/.pi/agent/sessions/ 下，文件名带时间戳 */
    runtime?: string;
  } = {},
): Promise<SessionSummary[]> {
  const livePathFor =
    opts.livePathFor ??
    ((cwd: string, sessionId: string) =>
      sessionJsonlPath(opts.runtime, cwd, sessionId) ?? projectJsonlPath(cwd, sessionId));
  const byId = new Map<string, SessionSummary>();

  const archiveDir = agentArchiveDir(agentName, opts.archiveRoot ?? ARCHIVE_ROOT);
  if (archiveDir && existsSync(archiveDir)) {
    try {
      for (const f of readdirSync(archiveDir)) {
        if (!f.endsWith(".jsonl") || !realpathWithin(join(archiveDir, f), archiveDir)) continue; // 指到目录外的符号链接不读
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
        // v2.23+ runtime 感知兜底：Pi 的文件名带时间戳，只能扫目录找
        const found = findSessionJsonlBySessionId(opts.runtime, sid);
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
    inbound?: InboundLookup; // T74 入站账（bridge 按 agent 传）：非 CC 记录对上账才认来源；不传一律保守
  } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const fmt = opts.formatToolFn ?? ((name: string) => name);
  const detailFn = opts.toolDetailFn;
  const before = opts.before;
  const after = opts.after;
  const maxFull = opts.maxFullReadBytes ?? MAX_HISTORY_FULL_READ_BYTES;

  const f = Bun.file(filePath);
  // v2.23+ 由路径判定 runtime（Pi 的会话根目录固定），解析层不必再被透传
  const runtime = runtimeForSessionPath(filePath);
  const size = f.size;

  // 小文件:一次全读,total 精确。单测与绝大多数会话走这条,行为与 v1 完全一致。
  if (size <= maxFull) {
    const all = parseHistoryLines((await f.text()).split("\n"), 0, fmt, detailFn, runtime, opts.inbound);
    return sliceHistoryPage(all, limit, before, after, all.length, false);
  }

  // 大文件:尾读加宽(2026-08-23 perf 根因,见文件头注释)。原先无条件全文读 +
  // 逐行 JSON.parse,232MB≈1.3s 同步阻塞 Bun 主线程,期间所有请求排队、SSE 心跳
  // 都发不出 → 手机端撞穿 BFF 8s/10s 超时 → 502 → 差量游标卡死「正在同步但永不
  // 更新」。差量 after= 每次重连都发、原先照样全文读,是这个 bug 的真凶。
  // 高频路径(默认页 / 差量)只需文件尾部,基本一窗命中;before 往回翻页从尾部
  // 反向扩窗直到够一页。贫路径(极深翻页)最坏读到全文,与 v1 持平。
  // 窗口不再无限 ×8 放大。原先 `win *= 8` 没有上限(8→64→512MB),深翻页一次请求就能把
  // 513MB 会话整读成 JS 字符串,单次峰值 1~1.5GB(2026-09-15 排查 bridge OOM 时一并发现)。
  // 两条路径分开处理,因为它们「需要读到哪」根本不同:
  //   · 默认页 / 差量(after=):结果集必须连到**文件尾部**,所以仍从尾部扩窗,但**封顶**。
  //     这两条到不了顶——默认页一窗就满;差量窗口只需覆盖客户端落后的那段。
  //   · 往回翻页(before=):要的是 before 之前那一页,跟尾部无关。改成**向前滑动**定长
  //     窗口,内存恒定、与翻页深度无关。判据也换成字节级的 `lineOffset <= before - limit`
  //     (与差量同款),不再靠「窗口里凑够 limit 条」——后者正是逼着窗口一路涨到 512MB 的
  //     原因:窗口离 before 越远,命中数越少,于是越扩越大。
  // 滑动窗宽 2×WIN、每次只退 1×WIN ⇒ 相邻两窗重叠一整窗,保证 limit(≤500)条的一页
  // 不会被窗口边界劈开。峰值内存 = 2×WIN = 16MB,与文件大小无关。
  const WIN = after != null ? 1024 * 1024 : 8 * 1024 * 1024;
  const MAX_TAIL_WIN = 64 * 1024 * 1024;
  const sliding = before != null;
  let tailWin = WIN;
  let slideCut = Math.max(0, size - WIN);
  for (;;) {
    const cut = sliding ? slideCut : Math.max(0, size - tailWin);
    const hi = sliding ? Math.min(size, slideCut + 2 * WIN) : size;
    const reachedStart = cut === 0;
    const lineOffset = await countNewlinesBefore(filePath, cut);
    // ⚠ runtime 必须传：全读分支(上面 442)传了、这里漏传的话，>16MB 的 Pi 会话会被
    //   当成 Claude Code 行解析 → 一条都认不出来 → all.length 恒为 0 → satisfied 永远
    //   不成立 → 扩窗一路跑到文件头，既全文读又返回空历史。
    const all = parseHistoryLines((await f.slice(cut, hi).text()).split("\n"), lineOffset, fmt, detailFn, runtime, opts.inbound);

    let satisfied = reachedStart;
    if (!satisfied) {
      if (after != null) {
        // 差量:窗口必须回读到锚点行(首行号 <= after),才拿得到完整的 seq>after 集合
        satisfied = lineOffset <= after;
      } else if (before != null) {
        // 窗口首行号已经早于「这一页的最早一条」⇒ 整页都在窗内
        satisfied = lineOffset <= before - limit;
      } else {
        satisfied = all.length >= limit;
      }
    }
    if (satisfied || reachedStart) {
      return sliceHistoryPage(all, limit, before, after, all.length, !reachedStart);
    }
    if (sliding) {
      slideCut = Math.max(0, slideCut - WIN);
    } else if (tailWin >= MAX_TAIL_WIN) {
      // 到顶还不满足:带 hasMore=true 如实返回,不再继续放大。
      return sliceHistoryPage(all, limit, before, after, all.length, true);
    } else {
      tailWin = Math.min(tailWin * 8, MAX_TAIL_WIN);
    }
  }
}

/** 从解析好的(全量或尾窗)消息里按 before/after/默认切页:after 与 before 互斥、after 优先;moreBefore=尾读且未读到文件头时为真(窗口之前还有更早消息)。 */
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
  opts: { maxHits?: number; maxFullScanBytes?: number; chunkBytes?: number; inbound?: InboundLookup } = {},
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
    const runtime = runtimeForSessionPath(filePath);
    const rec: any = translateSessionLine(runtime, line);
    if (!rec) continue;
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    // v2.21.4 被队列吸收的入站消息(attachment queued_command/prompt)与历史同规则可搜
    const queued = rec.type === "attachment" ? queuedPromptOf(rec) : null;
    if (queued) {
      const un = channelUserMessage(queued, idx, ts);
      if (!un) continue;
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
      const verified = verifiedForeignRecord(rec, text, runtime, opts.inbound); // 与历史同规则：对上入站账的按 CC 解包，其余 Pi / Codex 原文照搜
      const plain = verified === undefined ? plainUserText(rec, text, runtime) : undefined;
      if (plain !== undefined) body = plain;
      else if (rec.isMeta === true) {
        const un = channelUserMessage(verified ?? text, idx, ts); // channel 送达的入站消息解包；其余 isMeta（caveat / 命令输出）、bridge 注入不搜
        if (!un) continue;
        body = un.text;
        from = un.from;
      } else {
        // 与 readSessionHistory 同规则：机器产物不当用户消息搜
        if (!text.trim() || ccOwnRecord(text.trim(), runtime)) continue;
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

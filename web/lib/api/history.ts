/**
 * 历史拉取（此前 BFF app/api/chat/history 的编排部分；纯变换在 lib/chat/history-shape.ts）。
 * 三种取法，返回形状与 chat-store 既有约定一致：
 *   全量：最新 session 的最后 500 条（依次试最新的 3 个 session——/clear 轮转中途最新的可能正被拷贝）；
 *   after=<seq>+session：差量（唤醒秒画）；pinned 不再是最新 session → rotated；browse=1 = 历史现场向下翻，不做轮转检测；
 *   before=<seq>+session：向上分页；本 session 翻空 → 自动接上一个（更旧的）session 的尾页（stitched）。
 * 「删除」的隐藏区间（GET /agents/:name/hidden）在合并成气泡前剔掉；lastSeq / hasMore 按整页算。
 */
import type { ChatMessage } from "@/features/chat/type";
import { apiAgentName } from "@/lib/chat/agents";
import { selfIdsFrom, toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";
import { machines } from "@/lib/machines";
import { api, ApiError } from "./client";

export interface HistoryPage {
  data: ChatMessage[];
  sessionId?: string;
  lastSeq?: number | null;
  hasMore?: boolean;
  rotated?: boolean;
  stitched?: boolean;
}
export interface HistoryQuery {
  before?: number;
  after?: number;
  session?: string;
  browse?: boolean;
  signal?: AbortSignal;
}

interface Page {
  messages?: NeutralMessage[];
}
interface SessionList {
  sessions?: { sessionId: string }[];
}
interface HiddenRange {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
}

// ── 本人 id：whoami 5 分钟缓存（按机器）；拿不到就只认自己的聊天身份 ──
const SELF_TTL_MS = 5 * 60_000;
const selfCache = new Map<string, { at: number; ids: Set<string> }>();

export async function selfIds(): Promise<ReadonlySet<string>> {
  const cur = machines.current();
  const key = cur?.fp ?? "local";
  const hit = selfCache.get(key);
  if (hit && Date.now() - hit.at < SELF_TTL_MS) return hit.ids;
  let who: { tokenId?: unknown; ownerIds?: unknown } | null = null;
  try {
    who = await api("/whoami", { timeoutMs: 3000 });
  } catch (e) {
    console.warn("[history] whoami 取不到（本轮只按自己的聊天身份认本人）:", (e as Error).message);
  }
  const ids = selfIdsFrom(cur?.principalId, who);
  selfCache.set(key, { at: Date.now(), ids });
  return ids;
}

// ── 隐藏区间：按 agent 缓存 10s；hide / unhide 后失效 ──
const HIDDEN_TTL_MS = 10_000;
const hiddenCache = new Map<string, { at: number; ranges: HiddenRange[] }>();

export function invalidateHidden(agent: string): void {
  hiddenCache.delete(apiAgentName(agent));
}

async function hiddenPredicate(agentKey: string, sid: string): Promise<((seq: number) => boolean) | undefined> {
  let hit = hiddenCache.get(agentKey);
  if (!hit || Date.now() - hit.at > HIDDEN_TTL_MS) {
    let ranges: HiddenRange[] = [];
    try {
      ranges = (await api<{ ranges?: HiddenRange[] }>(`/agents/${encodeURIComponent(agentKey)}/hidden`, { timeoutMs: 5000 })).ranges ?? [];
    } catch (e) {
      console.warn("[history] 隐藏区间取不到（本轮不隐藏）:", (e as Error).message);
    }
    hit = { at: Date.now(), ranges };
    hiddenCache.set(agentKey, hit);
  }
  const mine = hit.ranges.filter((r) => r.sessionId === sid);
  if (!mine.length) return undefined;
  return (seq) => mine.some((r) => seq >= r.fromSeq && seq <= r.toSeq);
}

export async function fetchHistory(agent: string, q: HistoryQuery = {}): Promise<HistoryPage> {
  const agentKey = apiAgentName(agent);
  const name = encodeURIComponent(agentKey);
  const ids = await selfIds();
  const page = (sid: string, qs: string) => api<Page>(`/agents/${name}/history/${encodeURIComponent(sid)}${qs}`, { timeoutMs: 10_000, signal: q.signal });
  const sessions = () => api<SessionList>(`/agents/${name}/history`, { timeoutMs: 8000, signal: q.signal }).then((l) => (l.sessions ?? []).map((s) => s.sessionId));
  const shape = async (items: NeutralMessage[], sid: string, tail?: boolean) =>
    toChatMessages(items, { ...(tail === false ? { tail: false } : {}), sid, isHidden: await hiddenPredicate(agentKey, sid), selfIds: ids });
  try {
    if (q.after !== undefined && q.session) {
      if (!q.browse) {
        const newest = (await sessions())[0];
        if (newest && newest !== q.session) return { data: [], sessionId: q.session, rotated: true };
      }
      const items = (await page(q.session, `?limit=300&after=${q.after}`)).messages ?? [];
      // 差量的尾就是全局尾（完成标记正常渲染）；browse 不是；hasMore = 差量比一页还大 → 调用方放弃追加改走全量
      return { data: await shape(items, q.session, q.browse ? false : undefined), sessionId: q.session, lastSeq: items.length ? items[items.length - 1].seq : q.after, hasMore: items.length >= 300 };
    }
    if (q.before !== undefined && q.session) {
      const items = (await page(q.session, `?limit=300&before=${q.before}`)).messages ?? [];
      // 拿满一页 ≈ 还有更早；没拿满也标 true——本 session 翻到头后还能跨 session 接更早的会话
      if (items.length) return { data: await shape(items, q.session, false), sessionId: q.session, hasMore: true };
      const sids = await sessions();
      const idx = sids.indexOf(q.session);
      const older = idx >= 0 ? sids[idx + 1] : undefined; // mtime 降序，下一个 = 更旧
      if (!older) return { data: [], sessionId: q.session, hasMore: false };
      const tail = (await page(older, "?limit=300")).messages ?? [];
      return { data: await shape(tail, older, false), sessionId: older, stitched: true, hasMore: tail.length >= 300 || idx + 2 < sids.length };
    }
    const sids = await sessions();
    if (!sids.length) return { data: [] };
    let lastErr: unknown = null;
    for (const sid of sids.slice(0, 3)) {
      try {
        const items = (await page(sid, "?limit=500")).messages ?? [];
        // lastSeq = 合并成气泡前最后一条原始记录的 seq——差量同步的游标锚（不能用气泡 id 推）
        return { data: await shape(items, sid), sessionId: sid, lastSeq: items.length ? items[items.length - 1].seq : null, hasMore: items.length >= 500 };
      } catch (e) {
        lastErr = e; // not found（轮转竞态）→ 试下一个；其它错误也顺延，全败再抛
      }
    }
    throw lastErr ?? new Error("no readable session");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { data: [] }; // agent 尚无历史（新建）不是错误
    throw e;
  }
}

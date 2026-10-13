/**
 * 团队会话取页（team-project-TEAMVIS8）：一次 fetchPage = 向本机登记一次「要这一页」，再按 requestId 轮询到主场回传。
 * 主场 waitMs（30 秒）内没回就停、报主场离线；这里不重发，调用方（用户点「重新获取」）再调才发下一次。
 * 30 秒管的是整次取页（登记 + 轮询，从调用算起）：到点把在途的请求取消掉，之后才回来的页不收、不进缓存。
 * 请求过期只认中心的 410（expiresAt 是中心的钟，不拿浏览器的钟去比）。
 * 读到的页按卡缓存（再点开不用重取）。中心 403（不在项目成员里）清空整个缓存，撤权之前发出、之后才回来的页也不收
 * （撤权世代 revoked，同 team-body-source.ts）。403 不管从哪来（取页、对卡号时读 feature 详情、读正文时中心已答）都走 revoke() 这一个口。
 * 主场明确拒发（gate_refused）、主场未开放（not_open）丢掉这张卡的缓存。
 * 卡在中心的 taskId 团队详情里没有（只有 feature id 和卡号）：读一次该 feature 的中心详情，按主场卡号对上，对不上不猜。
 */
import { ApiError } from "@/lib/api/client";
import { sharedLedgerTransport, type FeatureDetail } from "@/lib/api/shared-ledger";
import type { TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";
import { teamSessionFailure, teamSessionTransport, type TeamSessionFailure, type TeamSessionTransport } from "@/lib/api/team-body-session";
import { sharedIdentity } from "../team-source-key";

export interface SessionCard { featureId: string; taskId: string }
export interface SessionPages { records: TeamBodyRecordWire[]; nextCursor: string | null }
export type SessionFailure = TeamSessionFailure;
export type SessionOutcome = { status: "page"; pages: SessionPages } | { status: SessionFailure };

export interface SessionTiming {
  pollMs: number; waitMs: number; now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** ms 后调 fire（整次取页的截止）；返回值 = 取消 */
  deadline: (ms: number, fire: () => void) => () => void;
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});
const deadline = (ms: number, fire: () => void) => { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); };
export const SESSION_TIMING: SessionTiming = { pollMs: 1500, waitMs: 30_000, now: Date.now, sleep, deadline };
const aborted = () => new DOMException("aborted", "AbortError");

export interface TeamSessionStore {
  /** 这张卡已经读到的页（没有 = 还没读过） */
  peek(card: SessionCard): SessionPages | null;
  /** cursor null = 最新一页（替换这张卡的缓存）；否则接着已读的往更早翻 */
  fetchPage(card: SessionCard, cursor: string | null, signal: AbortSignal): Promise<SessionOutcome>;
  /** 团队卡号 → 中心的卡；读不到 / 对不上为 null；中心答 403（不在项目成员里）为 "not_member"，缓存已清 */
  resolve(featureId: string, cardId: string, signal: AbortSignal): Promise<SessionCard | "not_member" | null>;
  /** 别处已经知道不是成员了（读正文时中心答 403）：清空缓存，在途的页回来也不收 */
  revoke(): void;
  /** 缓存了几张卡（测试看 403 清缓存） */
  cached(): number;
}

const keyOf = (c: SessionCard) => JSON.stringify([c.featureId, c.taskId]);
/** 团队卡号 = 主场卡号，重名时带「~n」后缀（team-source-adapter.ts）：去掉后缀后只有一张对得上才算 */
export function centerTaskOf(detail: Pick<FeatureDetail, "tasks">, cardId: string): string | null {
  const base = cardId.replace(/~\d+$/, "");
  const exact = detail.tasks.filter((t) => t.sourceTaskId.trim() === cardId);
  const hits = exact.length ? exact : detail.tasks.filter((t) => t.sourceTaskId.trim() === base);
  return hits.length === 1 ? hits[0]!.taskId : null;
}

export function teamSessionStore(transport: () => TeamSessionTransport, detail: (featureId: string, signal: AbortSignal) => Promise<FeatureDetail>,
  timing: () => SessionTiming = () => SESSION_TIMING): TeamSessionStore {
  const cache = new Map<string, SessionPages>();
  const cards = new Map<string, SessionCard>();
  let revoked = 0;
  const revoke = () => { revoked++; cache.clear(); cards.clear(); };
  const failed = (card: SessionCard, failure: SessionFailure): SessionOutcome => {
    if (failure === "not_member") revoke();
    if (failure === "gate_refused" || failure === "not_open") cache.delete(keyOf(card));
    return { status: failure };
  };
  return {
    peek: (card) => cache.get(keyOf(card)) ?? null,
    cached: () => cache.size,
    revoke,
    async resolve(featureId, cardId, signal) {
      const k = JSON.stringify([featureId, cardId]), hit = cards.get(k), gen = revoked;
      if (hit) return hit;
      try {
        const taskId = centerTaskOf(await detail(featureId, signal), cardId);
        if (gen !== revoked) return "not_member";
        if (!taskId) return null;
        const card = { featureId, taskId };
        cards.set(k, card);
        return card;
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ApiError && e.status === 403) { revoke(); return "not_member"; }
        return gen !== revoked ? "not_member" : null;
      }
    },
    async fetchPage(card, cursor, signal) {
      if (signal.aborted) throw aborted();
      const t = timing(), api = transport(), gen = revoked, k = keyOf(card);
      const started = t.now();
      // 整次取页一个截止：到点（或调用方中止）取消在途的请求；不认取消信号的请求也不再等
      const inner = new AbortController();
      let timedOut = false, flaky = false;
      const over = () => timedOut || t.now() - started > t.waitMs;
      const late = (): SessionOutcome => ({ status: flaky ? "unavailable" : "home_offline" });
      const stop = () => inner.abort();
      signal.addEventListener("abort", stop, { once: true });
      const cancel = t.deadline(t.waitMs, () => { timedOut = true; inner.abort(); });
      const cut = new Promise<never>((_, reject) => inner.signal.addEventListener("abort", () => reject(aborted()), { once: true }));
      cut.catch(() => {});
      const within = <T>(p: Promise<T>) => Promise.race([p, cut]);
      /** 请求失败：调用方中止照抛；403 不看早晚都清缓存；过了截止的其余失败按没等到算 */
      const thrown = (e: unknown): SessionOutcome | null => {
        if (signal.aborted) throw e;
        const failure = teamSessionFailure(e);
        if (failure === "not_member") return failed(card, failure);
        if (over()) return late();
        return failure === "unavailable" ? null : failed(card, failure);
      };
      try {
        const ticket = await within(api.request(card.featureId, card.taskId, cursor, inner.signal));
        if (over()) return late();
        for (;;) {
          try {
            const poll = await within(api.poll(card.featureId, card.taskId, ticket.requestId, inner.signal));
            // 过了截止才回来的页不收、不进缓存
            if (over()) return late();
            flaky = false;
            if (poll.status === "ready" && poll.result) {
              if (poll.result.kind === "refused") return failed(card, poll.result.code);
              // 在途时中心已回过 403：这页是撤权之前的，不显示、不缓存
              if (gen !== revoked) return { status: "not_member" };
              const { records, nextCursor } = poll.result;
              // bridge 已核过卡号；这里再挡一次换了身份后迟到的别的卡
              if (records.some((r) => r.kind !== "session-page" || r.featureId !== card.featureId || r.taskId !== card.taskId)) return { status: "unavailable" };
              const before = cursor === null ? [] : cache.get(k)?.records ?? [];
              const seen = new Set(records.map((r) => r.sourceKey));
              const pages = { records: [...before.filter((r) => !seen.has(r.sourceKey)), ...records], nextCursor };
              cache.set(k, pages);
              return { status: "page", pages };
            }
          } catch (e) {
            const out = thrown(e);
            if (out) return out;
            flaky = true; // 轮询偶发失败不算主场的答复：接着等，到时仍读不到按读不到报
          }
          if (t.now() - started + t.pollMs > t.waitMs) return late();
          await t.sleep(t.pollMs, inner.signal);
          if (signal.aborted) throw aborted();
          if (over()) return late();
        }
      } catch (e) {
        const out = thrown(e);
        if (out) return out;
        console.warn(`[team] 读会话页失败：${(e as Error).message}`);
        return failed(card, "unavailable");
      } finally {
        cancel();
        signal.removeEventListener("abort", stop);
      }
    },
  };
}

const stores = new Map<string, TeamSessionStore>();
let timing = SESSION_TIMING;
/** 测试用：换等待 / 轮询间隔；null 复原 */
export function setTeamSessionTimingForTest(t: Partial<SessionTiming> | null): void { timing = t ? { ...SESSION_TIMING, ...t } : SESSION_TIMING; }

/** 协作视图的团队项目键 → 它的取页器（按项目键留着，缓存跟着）；不是团队项目为 null */
export function teamSessionStoreOf(project: string): TeamSessionStore | null {
  const hit = stores.get(project);
  if (hit) return hit;
  const identity = sharedIdentity(project);
  if (!identity) return null;
  const machine = { fp: identity.machine };
  const store = teamSessionStore(() => teamSessionTransport(machine, identity.project),
    (featureId, signal) => sharedLedgerTransport(machine, identity.project).detail(featureId, signal), () => timing);
  stores.set(project, store);
  return store;
}

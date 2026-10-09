/**
 * 团队视图的数据源：中心共享台账经 SharedLedgerSession（身份校验、迟到响应作废）读，交给 team-source-adapter.ts 转形状。
 * 中心没有事件流：每 5 秒读一次 feature 列表，serverSeq 变了（或回退）才发一条 ledger 事件让 use-collab 重拉；
 * 重拉时 feature 详情按 rev / version / counts 复用，没变的不再读；只有执行镜像水位（sourceSeq / observedAt 是本机全局事件号，
 * 台账任一事件都会让所有 feature 一起变）变时同一 feature 至多每 60 秒重拉一次。中心按 IP 限流（2r/s、burst 20）：
 * 详情同时最多 2 个在途、每轮到期重拉有上限；回 429 本轮剩下的不再发、按 Retry-After 推迟，已缓存的照用。
 */
import type { FeatureDetail, FeatureList, SharedLedgerSession } from "@/lib/api/shared-ledger";
import type { BridgeEvent } from "@/lib/chat/stream-shape";
import { sharedProductBoard } from './dag/shared-product-model';
import { teamDagBoard, teamDagFeature } from './team-source-dag';
import { teamOverview, teamTaskDetail, type TeamOverview } from "./team-source-adapter";
import type { UnknownMetric } from "./collab-model";
import type { CollabHomeOnly, CollabSource, CollabUnavailable, FollowOpts } from "./team-source";

export const POLL_MS = 5_000;
/** 详情请求同时在途上限 */
export const DETAIL_CONCURRENCY = 2;
/** 只有执行镜像水位变时，同一 feature 的最短重拉间隔（打开的那个不受限） */
export const DETAIL_REFRESH_MS = 60_000;
/** 每轮因水位到期重拉的 feature 上限：5 秒一轮 ≈ 1.6r/s，低于中心 2r/s，到期的不会在同一轮挤爆 burst */
export const DETAIL_REFRESH_PER_ROUND = 8;
/** 429 没带 Retry-After 时推迟多久；带了也不超过上限 */
export const BACKOFF_DEFAULT_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

export interface SharedSourceOpts {
  concurrency?: number;
  refreshMs?: number;
  refreshPerRound?: number;
  now?: () => number;
}

/** 团队键对不上本机 registry / asks / last-seen / 谁在干活 / 成员卡：这些本机接口一律不调，界面显示「暂无」或隐藏 */
const UNAVAILABLE: ReadonlySet<CollabUnavailable> = new Set(["lastSeen", "workBoard", "presence", "ownerWaits", "teamPanel"]);
const HOME_ONLY: ReadonlySet<CollabHomeOnly> = new Set(["events.text", "review.text", "sessions", "say", "spec.full", "replay"]);
/** 投影里没有完成时刻 / 轮次 / 审查计数 / 等复核时长（observedAt 只是镜像刷新时刻）：四项都按未知给 */
const UNKNOWN_METRICS: readonly UnknownMetric[] = ["todayDone", "reviewRounds", "fixed", "reviewWait"];

export interface SharedSource extends CollabSource {
  /** 最近一次转好的总览与原始数据（团队操作按卡号找回 feature） */
  last(): { team: TeamOverview; list: FeatureList; details: ReadonlyMap<string, FeatureDetail> } | null;
  /** 提交成功 / 重读后立刻重拉 */
  poke(): void;
  /** 用户点进的 feature（dag.feature 读哪个就是哪个）：详情排最前、不受 60 秒限制，仍受并发与 429 退避约束 */
  focus(id: string | null): void;
}

type ListFeature = FeatureList["features"][number];
/** feature 自身会变的字段：变了下一轮立即重拉 */
const own = (f: ListFeature) => `${f.rev}:${f.version}:${f.status}:${f.counts.total}:${f.counts.completed}:${f.counts.blocked}:${f.counts.missing}`;
/** 执行镜像水位：本机全局事件号，只决定「到期再拉」 */
const mirror = (f: ListFeature) => `${f.projection?.sourceSeq ?? ""}:${f.projection?.observedAt ?? ""}`;

/** 429 → 推迟毫秒数：bridge 把中心 Retry-After（秒）透传成响应头并写进正文 retryAfter；没有按 5 秒，上限 60 秒。其他错误 → null */
export function detailBackoffMs(e: unknown): number | null {
  const err = e as { status?: unknown; body?: { retryAfter?: unknown } } | null;
  if (err?.status !== 429) return null;
  const raw = err.body?.retryAfter, s = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  return Math.min(BACKOFF_MAX_MS, Number.isFinite(s) && s >= 0 ? s * 1000 : BACKOFF_DEFAULT_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function sharedCollabSource(session: SharedLedgerSession, project: string, label: string, pollMs = POLL_MS, opts: SharedSourceOpts = {}): SharedSource {
  const { concurrency = DETAIL_CONCURRENCY, refreshMs = DETAIL_REFRESH_MS, refreshPerRound = DETAIL_REFRESH_PER_ROUND, now = Date.now } = opts;
  let last: ReturnType<SharedSource["last"]> = null;
  let open: string | null = null;
  /** 429 之后到这个时刻前不发详情请求 */
  let blockedUntil = 0;
  const cache = new Map<string, { own: string; mirror: string; at: number; d: FeatureDetail }>();
  const pokes = new Set<() => void>();
  const read = async (): Promise<NonNullable<typeof last>> => {
    const list = await session.list();
    if (!list) throw new DOMException("superseded", "AbortError");
    const details = new Map<string, FeatureDetail>();
    // 排队：打开的那个 → 没缓存的 → 自身变了的 → 水位到期的（最久没拉的先，每轮有上限）；其余用缓存
    const opened: ListFeature[] = [], fresh: ListFeature[] = [], changed: ListFeature[] = [], due: ListFeature[] = [];
    for (const f of list.features) {
      const hit = cache.get(f.id);
      if (hit) details.set(f.id, hit.d);
      if (hit && hit.own === own(f) && hit.mirror === mirror(f)) continue;
      if (f.id === open) opened.push(f);
      else if (!hit) fresh.push(f);
      else if (hit.own !== own(f)) changed.push(f);
      else if (now() - hit.at >= refreshMs) due.push(f);
    }
    due.sort((a, b) => cache.get(a.id)!.at - cache.get(b.id)!.at);
    const queue = [...opened, ...fresh, ...changed, ...due.slice(0, refreshPerRound)];
    let halted = now() < blockedUntil;
    const worker = async () => {
      for (let f = queue.shift(); f && !halted; f = queue.shift()) {
        try {
          const d = await session.detail(f.id);
          if (d) { cache.set(f.id, { own: own(f), mirror: mirror(f), at: now(), d }); details.set(f.id, d); }
        } catch (e) {
          const wait = detailBackoffMs(e);
          // 限流：本轮剩下的不再发，推迟下一次详情拉取；已缓存的详情上面已放进 details，不清空
          if (wait !== null) { halted = true; blockedUntil = Math.max(blockedUntil, now() + wait); continue; }
          // 单个 feature 读失败：事项照列、底下暂无任务（有缓存用缓存），下一轮再读；整页不因为一个 feature 报错
          console.warn(`[team] 读 feature ${f.id} 失败：${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    last = { team: teamOverview(list, details, Date.now()), list, details };
    return last;
  };
  const ledgerEvent = (): BridgeEvent => ({ seq: 0, ts: new Date().toISOString(), agent: "", chatId: "", type: "ledger", data: { project } });
  const board = async () => {
    const got = last ?? await read();
    return teamDagBoard(project, got.list, got.details, got.team);
  };
  return {
    label,
    unavailable: UNAVAILABLE,
    homeOnly: HOME_ONLY,
    dag: {
      board,
      feature: async (_project, id, version) => { open = id; return teamDagFeature(await board(), id, version); },
      diff: async () => { throw new Error('Shared version comparisons are unavailable'); },
    },
    product: async () => { const got = last ?? await read(); return sharedProductBoard(got.list, got.team.ov.now, got.team.ov.tasks, got.details); },
    last: () => last,
    poke: () => { for (const p of pokes) p(); },
    focus: (id) => { open = id; },
    overview: async () => ({ ...(await read()).team.ov, unknownMetrics: UNKNOWN_METRICS }),
    task: async (id) => {
      const got = last ?? (await read());
      const d = teamTaskDetail(got.team, id, Date.now());
      if (!d) throw new Error(`task "${id}" not found`);
      return d;
    },
    follow: async ({ signal, onOpen, onEvent }: FollowOpts) => {
      let seq = last?.list.serverSeq ?? null;
      const poke = () => onEvent(ledgerEvent());
      pokes.add(poke);
      onOpen();
      try {
        while (!signal.aborted) {
          await sleep(pollMs, signal);
          if (signal.aborted) return;
          const list = await session.list().catch((e: Error) => void console.warn(`[team] 轮询失败：${e.message}`)); // 下一轮再试，视图保留上一份
          if (list && list.serverSeq !== seq) { seq = list.serverSeq; poke(); }
        }
      } finally { pokes.delete(poke); }
    },
  };
}

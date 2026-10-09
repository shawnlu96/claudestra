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
/**
 * 显示的详情比列表投影落后多久才算「该重拉却没拉到」：水位变时同一 feature 至多每 DETAIL_REFRESH_MS 重拉一次，
 * 到期后最迟下一轮列表轮询拉到（team-project-N8A8B）。放在这里而不是 adapter：两个模块互相导入，
 * adapter 顶层引用这里的常量会在加载顺序反过来时撞 TDZ；adapter 只在调用时读它。
 */
export const DETAIL_BEHIND_MS = DETAIL_REFRESH_MS + POLL_MS;
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
  /** 最近一次转好的总览与原始数据（团队操作按卡号找回 feature）；fetchedAt = 各详情最近一次成功取回的时刻（读失败、429 停发不更新） */
  last(): { team: TeamOverview; list: FeatureList; details: ReadonlyMap<string, FeatureDetail>; waiting: ReadonlySet<string>; fetchedAt: ReadonlyMap<string, number> } | null;
  /** 提交成功 / 重读后立刻重拉 */
  poke(): void;
  /** 用户点进子 DAG 的 feature（use-dag-ui 的 featureId，关掉传 null）：详情排最前、不受 60 秒限制，仍受并发与 429 退避约束 */
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

type Got = NonNullable<ReturnType<SharedSource["last"]>>;
type Cached = { own: string; mirror: string; at: number; d: FeatureDetail };

/** 调用方中止只让它自己的 await 退出；读取本身是共用的，不中途作废 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * 这一轮拉哪些详情。排队：打开的那个 → 没缓存的 → 自身变了的 → 水位到期的（最久没拉的先，每轮有上限）；其余用缓存（放进 details）。
 * failed = 上次进了队列却没拉到（读失败、429 停发）、之后还没读成功的 feature。
 */
function planRound(features: readonly ListFeature[], cache: ReadonlyMap<string, Cached>, failed: ReadonlySet<string>, open: string | null, at: number, refreshMs: number, perRound: number) {
  const details = new Map<string, FeatureDetail>();
  const opened: ListFeature[] = [], fresh: ListFeature[] = [], changed: ListFeature[] = [], due: ListFeature[] = [];
  for (const f of features) {
    const hit = cache.get(f.id);
    if (hit) details.set(f.id, hit.d);
    if (hit && hit.own === own(f) && hit.mirror === mirror(f)) continue;
    if (f.id === open) opened.push(f);
    else if (!hit) fresh.push(f);
    else if (hit.own !== own(f)) changed.push(f);
    else if (at - hit.at >= refreshMs) due.push(f);
  }
  due.sort((a, b) => cache.get(a.id)!.at - cache.get(b.id)!.at);
  // 超出每轮上限、本轮没发请求的到期 feature：还在排队，不是读失败（N8A8B：概览不按「落后列表」判它过期）。
  // 读失败过、还没读成功的不算排队：列表顺序变了把它挤出上限，显示的仍是读失败回退的旧缓存
  const waiting = new Set(due.slice(perRound).filter((f) => !failed.has(f.id)).map((f) => f.id));
  return { details, queue: [...opened, ...fresh, ...changed, ...due.slice(0, perRound)], capped: due.length > perRound, waiting };
}

/** Polling and overview share one list attempt and cooldown, so a rerender cannot bypass Retry-After. */
function listReader(session: SharedLedgerSession, now: () => number) {
  let blockedUntil = 0;
  let running: Promise<{ list: FeatureList | undefined; limited: boolean }> | null = null;
  const read = () => {
    if (now() < blockedUntil) return Promise.resolve({ list: session.cached(), limited: true });
    return (running ??= session.list().then((list) => ({ list, limited: false })).catch((error: unknown) => {
      const wait = detailBackoffMs(error);
      if (wait === null) throw error;
      blockedUntil = Math.max(blockedUntil, now() + wait);
      return { list: session.cached(), limited: true };
    }).finally(() => { running = null; }));
  };
  return { read, ready: () => now() >= blockedUntil };
}

/**
 * 整个源只有一个读取器：同一时刻只有一轮在读（总览 / 子 DAG / 产品板同时挂载也是这一轮），详情在途上限与 429 停发对整个源成立。
 * 在读时再来要新数据的调用方合并成紧随其后的一轮（在途那轮可能早于这次变化）。
 */
function detailReader(session: SharedLedgerSession, opts: SharedSourceOpts) {
  const { concurrency = DETAIL_CONCURRENCY, refreshMs = DETAIL_REFRESH_MS, refreshPerRound = DETAIL_REFRESH_PER_ROUND, now = Date.now } = opts;
  const st = {
    last: null as Got | null,
    open: null as string | null,
    /** 429 之后到这个时刻前不发详情请求 */
    blockedUntil: 0,
    /** 上一轮有该拉没拉到的（429 停发、读失败、到期超出每轮上限）：轮询即使列表没变也再拉一轮 */
    incomplete: false,
    running: null as Promise<Got> | null,
  };
  const cache = new Map<string, Cached>();
  /** 进了队列却没拉到（读失败、429 停发）、之后还没读成功的 feature：不算排队（waiting） */
  const failed = new Set<string>();
  const lists = listReader(session, now);
  /** 并发 worker 拉一轮；返回是否有没拉到的 */
  const fetchAll = async (queue: ListFeature[], details: Map<string, FeatureDetail>): Promise<boolean> => {
    let missed = false, halted = false;
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (halted || now() < st.blockedUntil) { missed = true; failed.add(f.id); break; }
        try {
          const d = await session.detail(f.id);
          if (d) { cache.set(f.id, { own: own(f), mirror: mirror(f), at: now(), d }); details.set(f.id, d); failed.delete(f.id); }
        } catch (e) {
          missed = true;
          failed.add(f.id);
          const wait = detailBackoffMs(e);
          // 限流：本轮剩下的不再发，推迟下一次详情拉取；已缓存的详情已在 details 里，不清空
          if (wait !== null) { halted = true; st.blockedUntil = Math.max(st.blockedUntil, now() + wait); continue; }
          // 单个 feature 读失败：事项照列、底下暂无任务（有缓存用缓存），下一轮再读；整页不因为一个 feature 报错
          console.warn(`[team] 读 feature ${f.id} 失败：${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    for (const f of queue) failed.add(f.id);
    return missed || queue.length > 0;
  };
  const readOnce = async (): Promise<Got> => {
    const { list, limited } = await lists.read();
    if (limited && st.last) return st.last;
    if (!list) throw new DOMException("superseded", "AbortError");
    const { details, queue, capped, waiting } = planRound(list.features, cache, failed, st.open, now(), refreshMs, refreshPerRound);
    st.incomplete = (await fetchAll(queue, details)) || capped;
    const fetchedAt = new Map([...details.keys()].map((id) => [id, cache.get(id)!.at]));
    return (st.last = { team: teamOverview(list, details, now(), waiting, fetchedAt), list, details, waiting, fetchedAt });
  };
  let rerun: Promise<Got> | null = null;
  const read = (): Promise<Got> => {
    if (!st.running) return (st.running = readOnce().finally(() => { st.running = null; }));
    return (rerun ??= st.running.catch(() => {}).then(() => { rerun = null; return read(); }));
  };
  /** 有数据就用，没有就跟上在读的那一轮 */
  const current = (): Promise<Got> => (st.last ? Promise.resolve(st.last) : st.running ?? read());
  /** 退避过了、上一轮有没拉到的：该补一轮 */
  const owed = () => st.incomplete && !st.running && now() >= st.blockedUntil && lists.ready();
  return { st, cache, read, current, owed, lists };
}

export function sharedCollabSource(session: SharedLedgerSession, project: string, label: string, pollMs = POLL_MS, opts: SharedSourceOpts = {}): SharedSource {
  const r = detailReader(session, opts), { read, current } = r;
  const pokes = new Set<() => void>();
  const poke = () => { for (const p of pokes) p(); };
  const ledgerEvent = (): BridgeEvent => ({ seq: 0, ts: new Date().toISOString(), agent: "", chatId: "", type: "ledger", data: { project } });
  const board = async () => {
    const got = await current();
    return teamDagBoard(project, got.list, got.details, got.team);
  };
  return {
    label,
    unavailable: UNAVAILABLE,
    homeOnly: HOME_ONLY,
    dag: {
      board,
      feature: async (_project, id, version) => teamDagFeature(await board(), id, version),
      diff: async () => { throw new Error('Shared version comparisons are unavailable'); },
    },
    product: async (_project, signal) => { const got = await abortable(current(), signal); return sharedProductBoard(got.list, got.team.ov.now, got.team.ov.tasks, got.details); },
    last: () => r.st.last,
    poke,
    // 点进一个还没详情的 feature：立刻重拉一轮（它排最前），不等台账下一次变化
    focus: (id) => { if (id === r.st.open) return; r.st.open = id; if (id && !r.cache.has(id)) poke(); },
    overview: async (signal) => ({ ...(await abortable(read(), signal)).team.ov, unknownMetrics: UNKNOWN_METRICS }),
    task: async (id, signal) => {
      const got = await abortable(current(), signal);
      const d = teamTaskDetail(got.team, id, Date.now());
      if (!d) throw new Error(`task "${id}" not found`);
      return d;
    },
    follow: async ({ signal, onOpen, onEvent }: FollowOpts) => {
      let seq = r.st.last?.list.serverSeq ?? null;
      const ping = () => onEvent(ledgerEvent());
      pokes.add(ping);
      onOpen();
      try {
        while (!signal.aborted) {
          await sleep(pollMs, signal);
          if (signal.aborted) return;
          const got = await r.lists.read().catch((e: Error) => void console.warn(`[team] 轮询失败：${e.message}`)); // 下一轮再试，视图保留上一份
          const list = got?.list;
          if (list && list.serverSeq !== seq) { seq = list.serverSeq; ping(); }
          else if (r.owed()) ping(); // 上一轮有没拉到的详情：退避过了再补
        }
      } finally { pokes.delete(ping); }
    },
  };
}

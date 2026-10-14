/**
 * 团队视图的数据源：中心共享台账经 SharedLedgerSession（身份校验、迟到响应作废）读，交给 team-source-adapter.ts 转形状。
 * 中心没有事件流：每 15 秒读一次 feature 列表（页面在后台时不读，回到前台立刻读一次；CBUDGET2），serverSeq 变了（或回退）才发一条 ledger 事件让 use-collab 重拉；
 * 重拉时 feature 详情按 rev / version / counts 复用，没变的不再读；只有执行镜像水位（sourceSeq / observedAt 是本机全局事件号，
 * 台账任一事件都会让所有 feature 一起变）变时同一 feature 至多每 60 秒重拉一次，到期时列表没再变也补拉一轮。中心按 IP 限流（2r/s、burst 20）：
 * 详情同时最多 2 个在途、每轮到期重拉有上限；回 429 本轮剩下的不再发、按 Retry-After 推迟，已缓存的照用。
 */
import type { FeatureDetail, FeatureList, SharedLedgerSession } from "@/lib/api/shared-ledger";
import { teamBodyTransport, type TeamBodyTransport } from "@/lib/api/shared-ledger-team-body";
import { fetchLedgerTask, followCollabEvents } from "@/lib/api/ledger";
import { localProjectOf } from "@/lib/collab-source-binding";
import { rememberDetailTarget } from "./detail-pause-target";
import { markHomeRead } from "./detail-home-read";
import type { BridgeEvent } from "@/lib/chat/stream-shape";
import { sharedProductBoard } from './dag/shared-product-model';
import { teamDagBoard, teamDagFeature } from './team-source-dag';
import { listAhead, teamOverview, teamTaskDetail, type TeamOverview } from "./team-source-adapter";
import { bareAgent, type UnknownMetric } from "./collab-model";
import { reduceAction, type ActionMap } from "./collab-action";
import type { TaskDetail } from "./collab-detail-model";
import { sharedIdentity } from "./team-source-key";
import { teamBodyReader } from "./team-body/team-body-source";
import type { CollabHomeOnly, CollabSource, CollabUnavailable, FollowOpts } from "./team-source";

export const POLL_MS = 15_000;
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
/** 每轮因水位到期重拉的 feature 上限：一轮最多 8 个，低于中心 2r/s 的 burst，到期的不会在同一轮挤爆 */
export const DETAIL_REFRESH_PER_ROUND = 8;
/** 429 没带 Retry-After 时推迟多久；带了也不超过上限 */
export const BACKOFF_DEFAULT_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

export interface SharedSourceOpts {
  concurrency?: number;
  refreshMs?: number;
  refreshPerRound?: number;
  now?: () => number;
  /** 中心正文读口（测试注入）；缺省走本机 bridge 的 /shared-ledger/team-body/ 代理 */
  body?: TeamBodyTransport;
}

/** 团队键对不上本机 registry / asks / last-seen / 谁在干活 / 成员卡：这些本机接口一律不调，界面显示「暂无」或隐藏 */
const UNAVAILABLE: ReadonlySet<CollabUnavailable> = new Set(["lastSeen", "workBoard", "presence", "ownerWaits", "teamPanel"]);
const HOME_ONLY: ReadonlySet<CollabHomeOnly> = new Set(["events.text", "review.text", "sessions", "say", "spec.full", "replay"]);
const NONE: ReadonlySet<CollabHomeOnly> = new Set();
/** 读过中心正文的非主场详情（TEAMVIS7）：原文、审查、回放照本机显示；打开会话、对它说仍只在主场 */
const BODY_HOME_ONLY: ReadonlySet<CollabHomeOnly> = new Set(["sessions", "say"]);
/** 投影里没有完成时刻 / 轮次 / 审查计数 / 等复核时长（observedAt 只是镜像刷新时刻）：四项都按未知给 */
const UNKNOWN_METRICS: readonly UnknownMetric[] = ["todayDone", "reviewRounds", "fixed", "reviewWait"];

export interface SharedSource extends CollabSource {
  /**
   * 最近一次转好的总览与原始数据（团队操作按卡号找回 feature）；fetchedAt = 各详情最近一次成功取回的时刻（读失败、429 停发不更新）；
   * behindSince = 页面第一次观察到列表投影比显示详情新的时刻（列表与显示详情一致、或读成功追上时清掉），概览「落后列表」从它起算；
   * failed = 这一轮结束时进过队列却没拉到（读失败、429 停发）、之后还没读成功的 feature（只读快照；排队的 waiting 不在里面，TEAMCNT1）
   */
  last(): {
    team: TeamOverview; list: FeatureList; details: ReadonlyMap<string, FeatureDetail>; waiting: ReadonlySet<string>;
    fetchedAt: ReadonlyMap<string, number>; behindSince: ReadonlyMap<string, number>; failed: ReadonlySet<string>;
  } | null;
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

/** 页面可见性只用到这几样；根目录 tsc 不带 dom lib，经 globalThis 取 */
interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}
const pageDoc = (): VisibilityDoc | null => (globalThis as { document?: VisibilityDoc }).document ?? null;
/** 页面在后台（document.hidden）：列表轮询停下，不占中心限流；没有 document（非浏览器）按前台算 */
const hidden = () => pageDoc()?.hidden === true;

/**
 * 等下一轮列表轮询（CBUDGET2）：满 ms 且页面在前台才返回；后台期间一直等，期间进过后台的回到前台立刻返回（不等满 ms）。
 * 中止立刻返回
 */
function pollWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const doc = pageDoc();
    let due = false, wasHidden = hidden();
    const finish = () => {
      clearTimeout(t);
      doc?.removeEventListener("visibilitychange", onVisibility);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const onVisibility = () => { if (hidden()) wasHidden = true; else if (due || wasHidden) finish(); };
    const t = setTimeout(() => { due = true; if (!hidden()) finish(); }, ms);
    doc?.addEventListener("visibilitychange", onVisibility);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
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
 * nextDueAt = 水位变了、还没到重拉间隔的 feature 里最早到期的时刻（没有为 null）：列表不再变时靠它补一轮（team-project-N8A8H）。
 */
function planRound(features: readonly ListFeature[], cache: ReadonlyMap<string, Cached>, failed: ReadonlySet<string>, open: string | null, at: number, refreshMs: number, perRound: number) {
  const details = new Map<string, FeatureDetail>();
  const opened: ListFeature[] = [], fresh: ListFeature[] = [], changed: ListFeature[] = [], due: ListFeature[] = [];
  let nextDueAt: number | null = null;
  for (const f of features) {
    const hit = cache.get(f.id);
    if (hit) details.set(f.id, hit.d);
    if (hit && hit.own === own(f) && hit.mirror === mirror(f)) continue;
    if (f.id === open) opened.push(f);
    else if (!hit) fresh.push(f);
    else if (hit.own !== own(f)) changed.push(f);
    else if (at - hit.at >= refreshMs) due.push(f);
    else nextDueAt = Math.min(nextDueAt ?? Infinity, hit.at + refreshMs);
  }
  due.sort((a, b) => cache.get(a.id)!.at - cache.get(b.id)!.at);
  // 超出每轮上限、本轮没发请求的到期 feature：还在排队，不是读失败（N8A8B：概览不按「落后列表」判它过期）。
  // 读失败过、还没读成功的不算排队：列表顺序变了把它挤出上限，显示的仍是读失败回退的旧缓存
  const waiting = new Set(due.slice(perRound).filter((f) => !failed.has(f.id)).map((f) => f.id));
  return { details, queue: [...opened, ...fresh, ...changed, ...due.slice(0, perRound)], capped: due.length > perRound, waiting, nextDueAt };
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
    /** 上一轮水位变了、还没到期的 feature 最早到期时刻：到了即使列表没变也再拉一轮 */
    nextDueAt: null as number | null,
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
    const { details, queue, capped, waiting, nextDueAt } = planRound(list.features, cache, failed, st.open, now(), refreshMs, refreshPerRound);
    st.nextDueAt = nextDueAt;
    st.incomplete = (await fetchAll(queue, details)) || capped;
    const fetchedAt = new Map([...details.keys()].map((id) => [id, cache.get(id)!.at]));
    // 列表领先显示详情：沿用上一轮第一次看到的时刻，这一轮才看到的记现在；不领先（含空闲时一致、读成功追上）不记（team-project-N8A8G）
    const at = now(), prev = st.last?.behindSince;
    const behindSince = new Map(list.features.filter((f) => details.has(f.id) && listAhead(f, details.get(f.id)))
      .map((f) => [f.id, prev?.get(f.id) ?? at]));
    return (st.last = { team: teamOverview(list, details, at, waiting, fetchedAt, behindSince), list, details, waiting, fetchedAt, behindSince, failed: new Set(failed) });
  };
  let rerun: Promise<Got> | null = null;
  const read = (): Promise<Got> => {
    if (!st.running) return (st.running = readOnce().finally(() => { st.running = null; }));
    return (rerun ??= st.running.catch(() => {}).then(() => { rerun = null; return read(); }));
  };
  /** 有数据就用，没有就跟上在读的那一轮 */
  const current = (): Promise<Got> => (st.last ? Promise.resolve(st.last) : st.running ?? read());
  /** 退避过了、上一轮有没拉到的或有水位到期的：该补一轮 */
  const owed = () => (st.incomplete || (st.nextDueAt !== null && now() >= st.nextDueAt)) && !st.running && now() >= st.blockedUntil && lists.ready();
  return { st, cache, read, current, owed, lists };
}

/**
 * 主场本机（TEAMVIS0）：卡所在 feature 的主场实例 = 本机实例（团队键里的 homeInstanceId，即本机在这条绑定上的实例 id）时，
 * 返回它在本机台账里的卡号（主场镜像的 sourceTaskId）；比对不出（键里没有本机实例、没绑执行镜像、主场是别的机器）一律 null，按非主场处理
 */
export function homeCardOf(got: Pick<Got, "team" | "details">, id: string, localInstance: string | undefined): string | null {
  if (!localInstance) return null;
  const at = got.team.index.get(id);
  const d = at?.taskId ? got.details.get(at.featureId) : undefined;
  if (!at || d?.feature.homeInstanceId !== localInstance) return null;
  return d.tasks.find((t) => t.taskId === at.taskId)?.sourceTaskId ?? null;
}

interface HomeGood { d: TaskDetail; at: number; local: string; card: string }
/** 主场本机卡读本机详情失败、之前读成功过：返回上次本机详情的副本挂过期标记，仍按主场本机走（homeOnly 空集、真实卡号照旧登记） */
function keptHome(last: HomeGood, details: WeakSet<TaskDetail>, e: Error): TaskDetail {
  console.warn(`[team] 主场本机读详情失败，保留上次本机详情：${e.message}`);
  const kept: TaskDetail = { ...last.d };
  rememberDetailTarget(kept, last.local, last.card);
  details.add(kept);
  markHomeRead(kept, { kind: "stale", at: last.at });
  return kept;
}

/**
 * 主场本机卡（TEAMVIS0）的本机那一半：读本机台账详情、订本机 /events、筛执行者此刻动作。
 * 没读过主场本机卡就什么都不订，非主场请求边界不变。
 */
function homeMirror(project: string) {
  const localInstance = sharedIdentity(project)?.homeInstanceId;
  /** 主场本机读本机台账得到的详情：这些给空 homeOnly，其余照旧全集 */
  const details = new WeakSet<TaskDetail>();
  /** 读过主场本机卡的本机台账项目：follow 另订本机 /events 的这个项目，本机台账变了就发刷新（不等中心水位）；没读过就不订，非主场请求边界不变 */
  let homeProject: string | null = null;
  /** 主场本机卡上次读本机台账失败、退回了中心占位：下一轮轮询补一次刷新 */
  let stale = false;
  /** UXCARD3：good = 按团队卡号记上次成功的本机详情（同卡刷新读失败返回它、标过期）；failed = 从没读成功、退回的中心详情 */
  const good = new Map<string, HomeGood>(), failed = new WeakSet<TaskDetail>();
  /** 读过的主场本机卡上的执行者 / PM（前端会话名）：本机 /events 里只有它们的动作进 acts，别的本机 agent 不借给团队视图 */
  const agents = new Set<string>();
  /** 本机流里所有 agent 的此刻动作（只在内存，不外给）：执行者身份要等本机详情返回才定，详情在路上时先到的动作留着，身份定了再筛 */
  let seen: ActionMap = new Map();
  let acts: ActionMap = new Map();
  const actSubs = new Set<() => void>();
  /** acts = seen 里属于 agents 的；内容没变不通知 */
  const syncActs = () => {
    const next = new Map([...seen].filter(([n]) => agents.has(n)));
    if (next.size === acts.size && [...next].every(([n, a]) => acts.get(n) === a)) return;
    acts = next;
    for (const cb of actSubs) cb();
  };
  const setSeen = (next: ActionMap) => { if (next === seen) return; seen = next; syncActs(); };
  /** 在跑的 follow 的 followLocal：第一次读到主场本机卡时立刻订本机流，不等下一轮轮询 */
  const starters = new Set<() => void>();

  /** 中心详情 d 换成本机台账详情；不是主场本机卡原样返回 d */
  const task = async (got: Pick<Got, "team" | "details">, id: string, d: TaskDetail, signal: AbortSignal): Promise<TaskDetail> => {
    const card = homeCardOf(got, id, localInstance), local = card ? localProjectOf(project) : null;
    if (!card || !local) return d;
    const first = homeProject === null;
    homeProject = local;
    if (first) for (const s of starters) s();
    // 主场就是本机：和本机协作视图读同一份台账详情；读不到（本机没这张卡 / bridge 出错）退回中心的占位详情
    try {
      const own = await fetchLedgerTask(local, card, signal);
      // 卡号、事项号换成团队视图的（总览 ov.items 是中心 feature）：本机事项号和中心 feature.id 不一定相同，不换目标句查不到
      const out: TaskDetail = { ...own, task: { ...own.task, id, itemId: d.task.itemId } };
      rememberDetailTarget(out, local, card);
      details.add(out);
      good.set(id, { d: out, at: Date.now(), local, card });
      for (const n of [own.task.agent, own.task.pm]) { const b = bareAgent(n); if (b) agents.add(b); }
      syncActs(); // 详情返回前就到了的执行者动作，此刻放出来
      stale = false;
      return out;
    } catch (e) {
      if (signal.aborted) throw e;
      stale = true;
      const last = good.get(id);
      if (last) return keptHome(last, details, e as Error);
      console.warn(`[team] 主场本机读详情失败，按中心详情显示：${(e as Error).message}`);
      failed.add(d);
      return d;
    }
  };

  /** 一次 follow 的本机流：start 幂等（已连或没读过主场本机卡就不动）；due = 本机事件没连上、或上次本机读失败，该按轮询间隔补刷 */
  const follower = (signal: AbortSignal, ping: () => void) => {
    // 主场本机卡（TEAMVIS0）：另订本机 /events，本机台账这个项目变了就发一条团队项目的刷新；断了下一轮轮询重连，没连上期间按轮询间隔刷新
    let local: AbortController | null = null, localUp = false;
    const start = () => {
      const lp = homeProject;
      if (local || !lp) return;
      const mine = (local = new AbortController());
      const stop = () => mine.abort();
      signal.addEventListener("abort", stop, { once: true });
      followCollabEvents({
        signal: mine.signal,
        // 连上（含重连）补一次：断开期间的变化可能漏了；旧的此刻动作作废（同 use-collab onOpen），等新事件或 /agents 的 busy 兜底
        onOpen: () => { localUp = true; setSeen(new Map()); ping(); },
        onEvent: (e) => {
          if (e.type === "ledger") { if (e.data?.project === lp) ping(); return; }
          // 此刻动作：同 use-collab onAction 的成员过滤，成员 = 主场本机卡的执行者 / PM（团队键、中心总览认不出本机 agent）；筛在 syncActs
          setSeen(reduceAction(seen, e, Date.now()));
        },
      }).catch((e: Error) => { if (!mine.signal.aborted && localUp) console.warn(`[team] 本机台账事件断开：${e.message}`); }) // 连不上不逐轮刷屏
        .finally(() => { signal.removeEventListener("abort", stop); if (local === mine) { local = null; localUp = false; } });
    };
    starters.add(start);
    const due = () => { if (!homeProject || (localUp && !stale)) return false; stale = false; return true; };
    // 本机 /events 随 signal 一起中止（start 里挂的 abort）
    return { start, due, close: () => { starters.delete(start); } };
  };

  return {
    homeOnlyOf: (d: TaskDetail) => (details.has(d) ? NONE : HOME_ONLY),
    /** 这份中心详情是主场本机读失败退回来的 */
    failed: (d: TaskDetail) => failed.has(d),
    homeActions: {
      subscribe: (cb: () => void) => { actSubs.add(cb); return () => { actSubs.delete(cb); }; },
      get: () => acts,
    },
    task,
    follower,
  };
}

export function sharedCollabSource(session: SharedLedgerSession, project: string, label: string, pollMs = POLL_MS, opts: SharedSourceOpts = {}): SharedSource {
  const r = detailReader(session, opts), { read, current } = r;
  const home = homeMirror(project);
  const body = teamBodyReader(() => opts.body ?? teamBodyTransport({ fp: session.identity.machine }, session.identity.project));
  const localInstance = sharedIdentity(project)?.homeInstanceId ?? null;
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
    homeOnlyOf: (d) => (d.team ? BODY_HOME_ONLY : home.homeOnlyOf(d)),
    homeActions: home.homeActions,
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
      const now = Date.now(), d = teamTaskDetail(got.team, id, now);
      if (!d) throw new Error(`task "${id}" not found`);
      const own = await home.task(got, id, d, signal);
      if (own !== d) return own;
      // 非主场卡：读中心正文（主场传上来的脱敏原文）；还没开卡的计划节点没有正文可读，按同步中
      const at = got.team.index.get(id);
      const load = at?.taskId ? await body.load(at.featureId, at.taskId, signal) : { status: "syncing" as const };
      const out = teamTaskDetail(got.team, id, now, load, localInstance)!;
      if (home.failed(d)) markHomeRead(out, { kind: "failed" });
      return out;
    },
    follow: async ({ signal, onOpen, onEvent }: FollowOpts) => {
      let seq = r.st.last?.list.serverSeq ?? null;
      const ping = () => onEvent(ledgerEvent());
      pokes.add(ping);
      const local = home.follower(signal, ping);
      onOpen();
      try {
        while (!signal.aborted) {
          local.start();
          // 后台不轮询：回到前台立刻读一次，之后照常按 pollMs（打开的 feature 详情走 focus / poke，不受影响）
          await pollWait(pollMs, signal);
          if (signal.aborted) return;
          const got = await r.lists.read().catch((e: Error) => void console.warn(`[team] 轮询失败：${e.message}`)); // 下一轮再试，视图保留上一份
          const list = got?.list;
          if (list && list.serverSeq !== seq) { seq = list.serverSeq; ping(); }
          else if (r.owed()) ping(); // 上一轮有没拉到的详情、或水位领先的到了重拉间隔：退避过了再补
          else if (local.due()) ping(); // 本机事件没连上、或上次本机读失败：不等中心水位，按轮询间隔刷新
        }
      } finally { pokes.delete(ping); local.close(); }
    },
  };
}

/**
 * 团队视图的数据源：中心共享台账经 SharedLedgerSession（身份校验、迟到响应作废）读，交给 team-source-adapter.ts 转形状。
 * 中心没有事件流：每 5 秒读一次 feature 列表，serverSeq 变了（或回退）才发一条 ledger 事件让 use-collab 重拉；
 * 重拉时 feature 详情按 rev / 执行镜像水位复用，没变的不再读。
 */
import type { FeatureDetail, FeatureList, SharedLedgerSession } from "@/lib/api/shared-ledger";
import type { BridgeEvent } from "@/lib/chat/stream-shape";
import { sharedProductBoard } from './dag/shared-product-model';
import { teamDagBoard, teamDagFeature } from './team-source-dag';
import { teamOverview, teamTaskDetail, type TeamOverview } from "./team-source-adapter";
import type { UnknownMetric } from "./collab-model";
import type { CollabHomeOnly, CollabSource, CollabUnavailable, FollowOpts } from "./team-source";

export const POLL_MS = 5_000;

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
}

const watermark = (d: FeatureList["features"][number]) => `${d.rev}:${d.version}:${d.projection?.sourceSeq ?? ""}:${d.projection?.observedAt ?? ""}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function sharedCollabSource(session: SharedLedgerSession, project: string, label: string, pollMs = POLL_MS): SharedSource {
  let last: ReturnType<SharedSource["last"]> = null;
  const cache = new Map<string, { mark: string; d: FeatureDetail }>();
  const pokes = new Set<() => void>();
  const read = async (): Promise<NonNullable<typeof last>> => {
    const list = await session.list();
    if (!list) throw new DOMException("superseded", "AbortError");
    const details = new Map<string, FeatureDetail>();
    await Promise.all(list.features.map(async (f) => {
      const hit = cache.get(f.id);
      if (hit && hit.mark === watermark(f)) return void details.set(f.id, hit.d);
      try {
        const d = await session.detail(f.id);
        if (d) { cache.set(f.id, { mark: watermark(f), d }); details.set(f.id, d); }
      } catch (e) {
        // 单个 feature 读失败：事项照列、底下暂无任务，下一轮再读；整页不因为一个 feature 报错
        console.warn(`[team] 读 feature ${f.id} 失败：${(e as Error).message}`);
        if (hit) details.set(f.id, hit.d);
      }
    }));
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
      feature: async (_project, id, version) => teamDagFeature(await board(), id, version),
      diff: async () => { throw new Error('Shared version comparisons are unavailable'); },
    },
    product: async () => { const got = last ?? await read(); return sharedProductBoard(got.list, got.team.ov.now, got.team.ov.tasks, got.details); },
    last: () => last,
    poke: () => { for (const p of pokes) p(); },
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

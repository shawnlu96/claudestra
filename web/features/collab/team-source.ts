/**
 * 协作视图的数据源（i28-TV1）：总览、任务详情、台账变更事件，以及可选的 DAG / 产品读取。
 * 缺省是本机台账（GET /ledger/:project、/ledger/:project/tasks/:id、/events），和改之前一模一样；
 * 团队视图注入中心共享台账的适配（team-source-shared.ts），界面还是同一个 CollabView。
 * 这里不碰 react：tests/ 只能 import 纯模块。
 */
import { fetchDagBoard, fetchDagFeature, fetchDagDiff, fetchLedger, fetchLedgerTask, followCollabEvents } from "@/lib/api/ledger";
import type { LedgerOverview } from "./collab-model";
import type { TaskDetail } from "./collab-detail-model";
import type { BridgeEvent } from "@/lib/chat/stream-shape";
import type { ActionMap } from "./collab-action";

export interface FollowOpts {
  signal: AbortSignal;
  onOpen: () => void;
  onEvent: (e: BridgeEvent) => void;
}

/** 这个源拿不到、对应 hook 不发请求、界面显示「暂无」或隐藏的数据（源级、静态）；本机源不声明 = 全都有 */
export type CollabUnavailable = "lastSeen" | "workBoard" | "presence" | "ownerWaits" | "teamPanel";
/** 只在主场能看的原文 / 操作（源级、静态）；本卡只声明，界面上的「仅主场可见」由后续节点消费 */
export type CollabHomeOnly = "events.text" | "review.text" | "sessions" | "say" | "spec.full" | "replay";

export interface CollabSource {
  unavailable?: ReadonlySet<CollabUnavailable>;
  homeOnly?: ReadonlySet<CollabHomeOnly>;
  /** 按这份详情给 homeOnly（源级 homeOnly 的逐卡覆盖）：主场本机读本机台账的详情给空集（TEAMVIS0）；没有就用源级 homeOnly */
  homeOnlyOf?: (d: TaskDetail) => ReadonlySet<CollabHomeOnly> | undefined;
  /**
   * 主场本机详情（homeOnlyOf 给空集的那份）执行者的此刻动作（TEAMVIS0 r2）：团队源的 follow 只发中心 ledger 刷新，
   * 本机 agent_status / tool_start / tool_done 由源另订的本机 /events 收、只收读过的主场本机卡上的执行者 / PM；详情的「对它说」忙闲、此刻动作用它
   */
  homeActions?: { subscribe(cb: () => void): () => void; get(): ActionMap };
  dag?: {
    board: typeof fetchDagBoard;
    feature: typeof fetchDagFeature;
    diff: typeof fetchDagDiff;
  };
  product?: (project: string, signal?: AbortSignal) => Promise<import("@/lib/api/product-board").ProductBoard>;
  /** 顶栏标题；缺省用项目名 */
  label?: string;
  overview(signal: AbortSignal): Promise<LedgerOverview>;
  task(id: string, signal: AbortSignal): Promise<TaskDetail>;
  /** 连上调 onOpen（调用方全量重拉）；台账变了发一条 type=ledger、data.project=本项目的事件；signal 中止即结束 */
  follow(opts: FollowOpts): Promise<void>;
}

export function localCollabSource(project: string): CollabSource {
  return {
    overview: (signal) => fetchLedger(project, signal),
    task: (id, signal) => fetchLedgerTask(project, id, signal),
    follow: followCollabEvents,
  };
}

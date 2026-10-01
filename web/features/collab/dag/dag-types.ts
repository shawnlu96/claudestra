/**
 * 子 DAG 读接口（i28-L4）的响应形状。web 不 import src：照 src/lib/ledger-dag-board.ts（投影）与
 * src/bridge/local-api/ledger-dag.ts（三条路由）手抄，tests/web-collab-dag-contract.test.ts 拿 src 投影的真输出钉住两边一致。
 * 字段口径见 docs/design/feature-dag.md；前端一律按「可能缺字段」处理，坏数据不让画布崩。
 */

export type ReasonKind = "initial" | "new_issue" | "requirement_change" | "p1_fallback";
export type FeatureStatus = "active" | "paused" | "done" | "dropped";
export type NodePhase = "idle" | "active" | "done";
export type HandlerRole = "executor" | "reviewer" | "pm" | "dispatcher" | "owner";

export interface DagCancelView {
  key: string;
  taskId: string | null;
  reason: string;
}

export interface VersionMeta {
  version: number;
  reasonKind: ReasonKind;
  reasonText: string;
  proposedBy: string;
  approvedBy: string | null;
  createdAt: number;
  cancels: DagCancelView[];
  scopeChange: boolean;
  askId: string | null;
}

export type PendingMeta = VersionMeta & { seq: number; baseVersion: number; askId: string };

export interface StepLineLite {
  active: { step: string; round: number } | null;
  steps: { step: string; round: number; state: string }[];
}

export interface BoardNode {
  key: string;
  taskId: string | null;
  oneLine: string;
  deps: string[];
  estimate: string;
  inheritedFrom: number | null;
  fileGlobs?: string[];
  /** 卡的当前 stage；没卡 = "planned"；卡找不到 / 不属于本项目 = null */
  status: string | null;
  statusAtVersion: string;
  title: string | null;
  satisfied: boolean;
  ready: boolean;
  missing: boolean;
  phase: NodePhase;
  round: number | null;
  handler: { role: HandlerRole; agent: string | null; since: number } | null;
  stepLine: StepLineLite | null;
  /** 当前阶段的起点；idle / done 为 null = 不计时 */
  since: number | null;
  pr: string | null;
  branch: string | null;
}

export interface FeatureCounts {
  total: number;
  done: number;
  active: number;
  idle: number;
  missing: number;
}

export interface FeatureCard {
  id: string;
  title: string;
  status: FeatureStatus;
  ownerWords: string;
  /** 0 = 还没建图 */
  currentVersion: number;
  version: VersionMeta | null;
  pending: PendingMeta | null;
  counts: FeatureCounts;
  lastActivityAt: number | null;
  nodes: BoardNode[];
}

export interface WorkItem {
  featureId: string;
  nodeKey: string;
  taskId: string;
  role: string;
  step: string | null;
  round: number | null;
  since: number;
}

export interface OffGraphItem {
  taskId: string;
  stage: string;
  role: string;
  since: number;
}

export interface ProgressRowView {
  /** 去掉 agent- 前缀的裸名；peer 执行者是「名@peer」 */
  agent: string;
  pm: boolean;
  work: WorkItem[];
  offGraph: OffGraphItem[];
}

/** GET /api/v1/ledger/:project/dag */
export interface DagBoard {
  ok: true;
  project: string;
  exists: boolean;
  now: number;
  asOfSeq: number;
  features: FeatureCard[];
  agents: ProgressRowView[];
}

export interface VersionDelta {
  added: number;
  removed: number;
  changed: number;
  cancelled: number;
}

/** GET /api/v1/ledger/:project/dag/:featureId[?version=<n>|pending] */
export interface FeatureDetail {
  ok: true;
  project: string;
  now: number;
  feature: Omit<FeatureCard, "nodes">;
  versions: (VersionMeta & { delta: VersionDelta | null })[];
  snapshot: { version: number | "pending"; meta: VersionMeta; nodes: BoardNode[] } | null;
}

/** src/lib/ledger-dag-rules.ts DagDiff */
export interface DagDiffView {
  added: string[];
  removed: string[];
  carried: { key: string; changed: boolean }[];
  cancelled: DagCancelView[];
}

/** GET /api/v1/ledger/:project/dag/:featureId/diff?from=&to= */
export interface DagDiffResponse {
  ok: true;
  project: string;
  featureId: string;
  from: number;
  /** pending 的 to 由路由给成数字（提案的目标版本号），请求参数仍写 pending */
  to: number;
  diff: DagDiffView;
  phaseNow: Record<string, NodePhase>;
  rewrittenDone: string[];
}

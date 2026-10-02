/**
 * 子 DAG 重写的规矩（T89，设计稿 docs/design/feature-dag.md「只重写」四条）：纯函数，写入层在事务里拿现读的卡状态调用，
 * dag-approve 生效前按那一刻的卡状态再判一次——提案时没开始的节点，批下来之前可能已经开工了。
 * 节点三态看绑的卡（spec 规格卡 T89 的口径）：没卡或卡在 spec = 没开始；verified / done / cancelled = 已完成；其余（含 blocked、卡找不到）= 进行中。
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./ask-bind.js";
import type { DagReasonKind } from "./ledger-feature-schema.js";
import type { DagNode } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import type { Stage } from "./ledger-stages.js";

export type NodePhase = "idle" | "active" | "done";

const DONE_STAGES: readonly Stage[] = ["verified", "done", "cancelled"];

/** stage：绑的卡的当前阶段；绑了卡却找不到传 null（按进行中算：不能不声不响地移出去） */
export function nodePhase(taskId: string | null, stage: Stage | null): NodePhase {
  if (!taskId || stage === "spec") return "idle";
  return stage && DONE_STAGES.includes(stage) ? "done" : "active";
}

/** 被取消的进行中节点：原因必填，记进新版本 */
export interface DagCancel {
  key: string;
  taskId: string | null;
  reason: string;
}

const sortedDeps = (n: DagNode) => [...n.deps].sort().join("\n");
const sortedGlobs = (n: DagNode) => [...(n.fileGlobs ?? [])].sort().join("\n");
/** 原样：key、绑的卡、一句话、依赖（不计顺序）、粗估、文件范围（不计顺序；没带算空）都一样 */
const sameNode = (a: DagNode, b: DagNode): boolean =>
  a.key === b.key && a.taskId === b.taskId && a.oneLine === b.oneLine && a.estimate === b.estimate && sortedDeps(a) === sortedDeps(b) && sortedGlobs(a) === sortedGlobs(b);

export interface RewritePlan {
  /** 新版本的节点：和当前版原样一致的标 inheritedFrom = 当前版本号 */
  nodes: DagNode[];
  cancels: DagCancel[];
  /** 为什么要 owner 批：只有声明改范围 / 大改机制（--scope-change）；空 = 直接生效 */
  needsOwner: string[];
}

export interface CurrentDag {
  version: number;
  /** 已并上 dag-bind 绑的卡 */
  nodes: readonly DagNode[];
}

/**
 * 判一次重写：已完成的节点必须原样带入；进行中的节点移出去（key 没了或换了卡）必须在 cancel 里写原因；cancel 只能点名被移出的进行中节点。
 * 要 owner 批的只有 PM 声明改 feature 范围或大改机制（scopeChange）；改 / 取消进行中的节点都直接生效。违规抛 invalid，不猜。
 */
export function planRewrite(cur: CurrentDag, phase: (n: DagNode) => NodePhase, next: readonly DagNode[], cancel: ReadonlyMap<string, string>, scopeChange: boolean): RewritePlan {
  const byKey = new Map(next.map((n) => [n.key, n]));
  const cancels: DagCancel[] = [];
  for (const n of cur.nodes) {
    const p = phase(n);
    const m = byKey.get(n.key);
    if (p === "done" && !(m && sameNode(n, m))) throw new LedgerError("invalid", `已完成的节点 ${n.key} 必须原样带入（key、一句话、依赖、粗估、文件范围、绑的卡都不能变）`);
    if (p !== "active") continue;
    if (!m || m.taskId !== n.taskId) {
      const reason = cancel.get(n.key);
      if (!reason) throw new LedgerError("invalid", `进行中的节点 ${n.key}（${n.taskId}）不在新版本里：要在 --cancel ${n.key}=<原因> 里写明`);
      cancels.push({ key: n.key, taskId: n.taskId, reason });
    }
  }
  for (const key of cancel.keys()) {
    if (!cancels.some((c) => c.key === key)) throw new LedgerError("invalid", `--cancel ${key}：它不是这次被移出的进行中节点`);
  }
  const inherit = new Map(cur.nodes.map((n) => [n.key, n]));
  const nodes = next.map((n) => {
    const old = inherit.get(n.key);
    return { ...n, ...(old?.cardSlug !== undefined ? { cardSlug: old.cardSlug } : {}),
      inheritedFrom: old && sameNode(old, n) ? cur.version : null };
  });
  if (nodes.length === cur.nodes.length && nodes.every((n) => n.inheritedFrom !== null)) throw new LedgerError("invalid", "新版本和当前版本一模一样，不用重写");
  return { nodes, cancels, needsOwner: scopeChange ? ["声明改 feature 范围或大改机制（--scope-change）"] : [] };
}

export interface ProposalContent {
  featureId: string;
  version: number;
  baseVersion: number;
  reasonKind: DagReasonKind;
  reasonText: string;
  nodes: readonly DagNode[];
  cancels: readonly DagCancel[];
  scopeChange: boolean;
}

/** 审批绑定的快照哈希：提案的全部内容（节点快照、取消、原因、基于哪版）一起算，批准时从库里的提案行重算比对 */
export const proposalSha = (p: ProposalContent): string =>
  createHash("sha256").update(canonicalJson(p)).digest("hex");

export interface DagDiff {
  added: string[];
  /** 移出去的没开始 / 计划中节点 */
  removed: string[];
  /** 两版都有；changed = 内容不一样 */
  carried: { key: string; changed: boolean }[];
  /** 移出去的进行中节点，带取消原因 */
  cancelled: DagCancel[];
}

/** a → b 的节点粒度差异；cancels = (a, b] 之间各版记下的取消 */
export function diffNodes(a: readonly DagNode[], b: readonly DagNode[], cancels: readonly DagCancel[]): DagDiff {
  const inB = new Map(b.map((n) => [n.key, n]));
  const inA = new Set(a.map((n) => n.key));
  const gone = a.filter((n) => !inB.has(n.key)).map((n) => n.key);
  // 取消也可能是 key 还在、换了卡：那一条两类都算（带入且变了 + 取消）
  const cancelled = cancels.filter((c) => inA.has(c.key));
  return {
    added: b.filter((n) => !inA.has(n.key)).map((n) => n.key),
    removed: gone.filter((k) => !cancelled.some((c) => c.key === k)),
    carried: a.filter((n) => inB.has(n.key)).map((n) => ({ key: n.key, changed: !sameNode(n, inB.get(n.key) as DagNode) })),
    cancelled,
  };
}

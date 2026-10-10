/** Current node bindings and unopened-card reasons use only board facts, never dispatch guesses. */
import type { BoardNode, FeatureCard } from "./dag-types";

export interface NodeCard { feature: FeatureCard; node: BoardNode }
export function nodeCard(features: readonly FeatureCard[], taskId: string | null): NodeCard | null {
  if (!taskId) return null;
  for (const feature of features) {
    if (feature.currentVersion < 1) continue;
    const node = feature.nodes.find(n => n.taskId === taskId && !n.missing);
    if (node) return { feature, node };
  }
  return null;
}

/** Team planned nodes can have ready=true despite unmet dependencies; satisfied is the shared contract. */
export function unopenedReason(feature: FeatureCard, node: BoardNode): { text: string; deps?: string } {
  const unmet = node.deps.filter(key => !feature.nodes.find(n => n.key === key)?.satisfied);
  if (unmet.length) return { text: "前置没满足：{deps}", deps: unmet.join(" · ") };
  if (!node.fileGlobs?.length) return { text: "没写文件范围" };
  if (feature.status === "paused") return { text: "feature 已暂停" };
  return { text: "前置都已满足，还没开卡" };
}

export function nodeTask(feature: FeatureCard | undefined, key: string, tasks: readonly { id: string }[], comparing = false): string | null {
  if (comparing || !feature || feature.currentVersion < 1) return null;
  const node = feature.nodes.find(n => n.key === key);
  return node?.taskId && !node.missing && tasks.some(t => t.id === node.taskId) ? node.taskId : null;
}

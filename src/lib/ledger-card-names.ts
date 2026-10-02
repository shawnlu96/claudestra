import type { Database } from "bun:sqlite";
import { getDagVersion, type DagNode, type Feature } from "./ledger-feature.js";
import { storedOrigin } from "./ledger-origin.js";

/** 卡号 / agent / 分支的派生规则与 start_node 的缺省一致（dag-tools-start.ts）：两边开同一个节点会撞同一个卡号，由台账的唯一性裁决 */
export function cardNames(db: Database, f: Feature, key: string, existingNode?: Pick<DagNode, "cardSlug">): { slug: string; taskId: string; agent: string; branch: string } {
  const origin = storedOrigin(db);
  // 新节点沿用当前版本唯一的卡号前缀；显式前缀优先，历史版本和待批提案不参与推断。
  const nodes = existingNode?.cardSlug !== undefined || !f.currentVersion ? [] : (getDagVersion(db, f.id, f.currentVersion)?.nodes ?? []);
  const node = existingNode ?? nodes.find((n) => n.key === key);
  const slugs = new Set(nodes.map((n) => n.cardSlug).filter((s): s is string => s !== undefined));
  const inherited = slugs.size === 1 ? slugs.values().next().value : undefined;
  const slug = node?.cardSlug ?? inherited ?? (origin && f.id.startsWith(`${origin}-`) ? f.id.slice(origin.length + 1) : f.id);
  const taskId = `${slug}-${key}`;
  const agent = `agent-${`task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48)}`;
  return { slug, taskId, agent, branch: `feat/${taskId.toLowerCase()}` };
}

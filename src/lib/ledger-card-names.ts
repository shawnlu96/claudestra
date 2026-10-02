import type { Database } from "bun:sqlite";
import { getDagVersion, type Feature } from "./ledger-feature.js";
import { storedOrigin } from "./ledger-origin.js";

/** 卡号 / agent / 分支的派生规则与 start_node 的缺省一致（dag-tools-start.ts）：两边开同一个节点会撞同一个卡号，由台账的唯一性裁决 */
export function cardNames(db: Database, f: Feature, key: string): { slug: string; taskId: string; agent: string; branch: string } {
  const origin = storedOrigin(db);
  const node = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion)?.nodes.find((n) => n.key === key) : undefined;
  const slug = node?.cardSlug ?? (origin && f.id.startsWith(`${origin}-`) ? f.id.slice(origin.length + 1) : f.id);
  const taskId = `${slug}-${key}`;
  const agent = `agent-${`task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48)}`;
  return { slug, taskId, agent, branch: `feat/${taskId.toLowerCase()}` };
}


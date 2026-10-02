import type { Database } from "bun:sqlite";
import { effectiveNodes, getDagVersion, getFeature, type DagNode, type Feature } from "./ledger-feature.js";
import { storedOrigin } from "./ledger-origin.js";
import { LedgerError } from "./ledger-store.js";

/** 没有固化前缀的节点用的卡号前缀：给定节点里唯一的 cardSlug，否则按 feature id 去掉 origin */
function inferredSlug(db: Database, f: Pick<Feature, "id">, nodes: readonly Pick<DagNode, "cardSlug">[]): string {
  const slugs = new Set(nodes.map((n) => n.cardSlug).filter((s): s is string => s !== undefined));
  if (slugs.size === 1) return slugs.values().next().value as string;
  const origin = storedOrigin(db);
  return origin && f.id.startsWith(`${origin}-`) ? f.id.slice(origin.length + 1) : f.id;
}

const currentNodes = (db: Database, f: Pick<Feature, "id" | "currentVersion">): DagNode[] =>
  f.currentVersion ? (getDagVersion(db, f.id, f.currentVersion)?.nodes ?? []) : [];

/** 卡号 / agent / 分支的派生规则与 start_node 的缺省一致（dag-tools-start.ts）：两边开同一个节点会撞同一个卡号，由台账的唯一性裁决 */
export function cardNames(db: Database, f: Feature, key: string, existingNode?: Pick<DagNode, "cardSlug">): { slug: string; taskId: string; agent: string; branch: string } {
  // 新节点沿用当前版本唯一的卡号前缀；显式前缀优先，历史版本和待批提案不参与推断。
  const nodes = existingNode?.cardSlug !== undefined ? [] : currentNodes(db, f);
  const node = existingNode ?? nodes.find((n) => n.key === key);
  const slug = node?.cardSlug ?? inferredSlug(db, f, nodes);
  const taskId = `${slug}-${key}`;
  const agent = `agent-${`task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48)}`;
  return { slug, taskId, agent, branch: `feat/${taskId.toLowerCase()}` };
}

/** 写入时固化前缀 + 兄弟校验要的数据：在写入事务里现读好，传给纯函数 pinNodes */
export interface CardContext {
  /** 写入前当前版本推断出的前缀（与 cardNames 此刻给没固化节点的一致）；新 feature 按 feature id */
  slug: string;
  /** 别的 feature 占着的卡号 → 那个 feature：它们当前版本里的节点（没固化的按推断前缀），以及挂在它们名下的卡 */
  taken: ReadonlyMap<string, string>;
}

/** 一个 feature 当前版本里每个节点的卡号（没固化前缀的按 cardNames 的口径推断） */
function cardIdsOf(db: Database, f: Feature): string[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) return [];
  const nodes = effectiveNodes(db, v), slug = inferredSlug(db, f, nodes);
  return nodes.map((n) => `${n.cardSlug ?? slug}-${n.key}`);
}

/** exclude：这次写入里一起改的 feature（拆分的源 / 目标），由调用方按写入后的节点自己补进 taken */
export function cardContext(db: Database, f: Pick<Feature, "id" | "currentVersion">, exclude: readonly string[] = []): CardContext {
  const skip = new Set([f.id, ...exclude]), taken = new Map<string, string>();
  const tasks = db.query("SELECT id, featureId FROM tasks WHERE featureId IS NOT NULL").all() as { id: string; featureId: string }[];
  for (const t of tasks) if (!skip.has(t.featureId)) taken.set(t.id, t.featureId);
  for (const { id } of db.query("SELECT id FROM features ORDER BY id").all() as { id: string }[]) {
    const g = skip.has(id) ? null : getFeature(db, id);
    if (g) for (const card of cardIdsOf(db, g)) if (!taken.has(card)) taken.set(card, id);
  }
  return { slug: inferredSlug(db, f, currentNodes(db, f)), taken };
}

/**
 * 纯函数：没有 cardSlug 的节点固化成 ctx.slug（之后删掉别的节点也不会漂）；fresh 里的 key（这次新写进来的）
 * 在同一前缀下撞了别的 feature 的 key 就整次拒绝，报冲突的 feature 和 key。
 */
export function pinNodes<T extends Pick<DagNode, "key" | "cardSlug">>(ctx: CardContext, nodes: readonly T[], fresh: (n: T) => boolean): T[] {
  const pinned = nodes.map((n) => (n.cardSlug !== undefined ? n : { ...n, cardSlug: ctx.slug }));
  const bad = pinned.filter(fresh).flatMap((n) => {
    const card = `${n.cardSlug}-${n.key}`, owner = ctx.taken.get(card);
    return owner ? [`节点 ${n.key}：卡号前缀 ${n.cardSlug} 下 feature ${owner} 已有同名 key（卡号 ${card}）`] : [];
  });
  if (bad.length) throw new LedgerError("invalid", `兄弟 feature 卡号冲突，整次写入拒绝：${bad.join("；")}`);
  return pinned;
}

/** 从同一台账读事务取车道、实际文件锁与旧发现；规格只检查正式路径是否存在。 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { featureLanes, globsOverlap, heldFileLocks } from "./dag-tools-lanes.js";
import { cardNames } from "./ledger-card-names.js";
import { effectiveNodes, getDagVersion } from "./ledger-feature.js";
import { listTasks } from "./ledger-store.js";
import { activeFeatures } from "./scheduler-autostart.js";
import { autostartSpecPath } from "./scheduler-autostart-deps.js";
import { STALL_RULES, type LockBlockerFact, type StallInputs } from "./ledger-audit-stall.js";

/** 快照来源可带这个可选端口；测试不读真实状态目录。 */
export interface StallReadSources { stallSpecExists?: (path: string) => boolean }
function openKeys(db: Database, project: string): NonNullable<StallInputs["stall"]>["open"] {
  const open: NonNullable<StallInputs["stall"]>["open"] = {};
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'").get()) return open;
  for (const rule of STALL_RULES) {
    const prefix = `${project}|${rule}|`;
    open[rule] = (db.query("SELECT key FROM audit_findings WHERE project = ? AND rule = ? AND resolvedAt IS NULL").all(project, rule) as { key: string }[])
      .filter((r) => r.key.startsWith(prefix)).map((r) => r.key.slice(prefix.length));
  }
  return open;
}
function blockerFacts(db: Database, project: string, specExists: (path: string) => boolean): LockBlockerFact[] {
  const facts: LockBlockerFact[] = [], held = heldFileLocks(db, project), tasks = new Map(listTasks(db, project).map((t) => [t.id, t]));
  for (const f of activeFeatures(db, project)) {
    const v = getDagVersion(db, f.id, f.currentVersion!), lanes = featureLanes(db, f);
    if (!v || !lanes) continue;
    const nodes = new Map(effectiveNodes(db, v).map((n) => [n.key, n]));
    for (const waiting of lanes.waiting) {
      const node = nodes.get(waiting.key);
      if (waiting.why !== "files" || !node || !specExists(autostartSpecPath(cardNames(db, f, node.key, node).taskId))) continue;
      for (const occupant of waiting.on) {
        const bound = nodes.get(occupant), id = bound ? bound.taskId : occupant;
        if (!id || !tasks.has(id)) continue; // 同轮挑出的 startNow 计划节点没有卡，不是挡路卡。
        const extra = tasks.get(id)!.extra.fileGlobs;
        const declared = bound?.fileGlobs ?? (Array.isArray(extra) ? extra.filter((g): g is string => typeof g === "string") : []);
        const occupied = held.get(id)?.length ? held.get(id)! : declared;
        const files = (node.fileGlobs ?? []).filter((g) => globsOverlap([g], occupied));
        facts.push({ taskId: id, feature: f.id, node: node.key, files });
      }
    }
  }
  return facts;
}
export function readStallAudit(db: Database, project: string, sources: object = {}): NonNullable<StallInputs["stall"]> {
  let open: NonNullable<StallInputs["stall"]>["open"] = {};
  try {
    return db.transaction(() => {
      open = openKeys(db, project);
      return { open, blockers: { facts: blockerFacts(db, project, (sources as StallReadSources).stallSpecExists ?? existsSync) } };
    }).deferred();
  } catch {
    // 车道或规格取数失败不应结清或发送旧发现；手动卡规则仍可使用已有任务事件。
    return { open, blockers: { unreadable: "挡路卡事实读不了" } };
  }
}

/** tick 私有的读侧预筛：跨 feature 共用项目事实，提醒和选卡共用各 feature 车道。 */
import type { Database } from "bun:sqlite";
import { featureLanes, readLaneProject, type LaneProjectSnapshot, type Lanes } from "./dag-tools-lanes.js";
import type { Feature, NodeView } from "./ledger-feature.js";
import { listTasks } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { currentViews, type ServiceFacts } from "./scheduler-autostart.js";
import { autostartCapacity } from "./scheduler-slot-hold-autostart.js";

export interface AutostartReads {
  tasks(project: string): LedgerTask[];
  feature(f: Feature): { lanes: Lanes | null; views: NodeView[] };
}

/** 不挂模块级缓存；本连接写入、别的连接提交、调度写口调用都会清空，claim / 开卡不接这份快照。 */
export function autostartSnapshot(db: Database, svc: ServiceFacts) {
  const tasks = new Map<string, LedgerTask[]>(), projects = new Map<string, LaneProjectSnapshot>();
  const features = new Map<string, { lanes: Lanes | null; views: NodeView[] }>(), capacity = new Map<string, string | null>();
  const revision = () => JSON.stringify([db.query("PRAGMA data_version").get(), db.query("SELECT total_changes() AS n").get()]);
  let rev = revision();
  const invalidate = () => { tasks.clear(); projects.clear(); features.clear(); capacity.clear(); rev = revision(); };
  const fresh = () => { if (revision() !== rev) invalidate(); };
  const reads: AutostartReads = {
    tasks(project) {
      fresh();
      if (!tasks.has(project)) tasks.set(project, listTasks(db, project));
      return tasks.get(project)!;
    },
    feature(f) {
      fresh();
      const key = JSON.stringify([f.project, f.id, f.currentVersion]);
      if (!features.has(key)) {
        const value = db.transaction(() => {
          const cards = reads.tasks(f.project);
          if (!projects.has(f.project)) projects.set(f.project, readLaneProject(db, f.project, cards));
          const views = currentViews(db, f);
          return { views, lanes: featureLanes(db, f, projects.get(f.project), views) };
        }).deferred();
        features.set(key, value);
      }
      return features.get(key)!;
    },
  };
  const cachedSvc: ServiceFacts = { ...svc, capacity: (...args) => {
    fresh();
    const [, project, max, pool, now, repo] = args;
    const key = JSON.stringify([project, max, pool, repo ?? null]);
    if (!capacity.has(key)) capacity.set(key, (svc.capacity ?? autostartCapacity)(db, project, max, pool, now, repo, reads.tasks(project)));
    return capacity.get(key)!;
  } };
  return { reads, svc: cachedSvc, invalidate };
}

import type { Database } from "bun:sqlite";

export interface FeatureDep {
  project: string;
  from: string;
  to: string;
  note: string;
  createdBy: string;
  createdAt: number;
}

/** Old read-only databases have not run this migration yet. */
export function featureDeps(db: Database, project?: string, feature?: string): FeatureDep[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature_deps'").get()) return [];
  const rows = db.query("SELECT project, fromFeature AS 'from', toFeature AS 'to', note, createdBy, createdAt FROM feature_deps ORDER BY fromFeature,toFeature")
    .all() as FeatureDep[];
  return rows.filter((d) => (!project || d.project === project) && (!feature || d.from === feature || d.to === feature));
}

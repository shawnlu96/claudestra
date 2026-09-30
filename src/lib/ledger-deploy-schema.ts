/**
 * scheduler_deploys（T68g）：合并之后的自动部署 journal，一行对应一个已到 merged 的合并意图。单独成表而不是给 scheduler_merges
 * 加阶段：那张表的 phase CHECK 改不了（SQLite 要重建表），新表只加不改，不用迁移旧数据。
 * 每行分开记「部署走到哪」（phase）、「结论」（outcome）和「核对过的存活」（liveness）：r4 拆卡的根子就是这两件事混在一个 unknown 里。
 * CHECK 保证 deployed / unknown 只能在确认部署进程已不在（liveness=dead）时写入——unknown 因此永远不和在跑的部署重叠。
 * 迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，每步可重跑。tests/scheduler-deploy.test.ts。
 */
import type { Database } from "bun:sqlite";

export const DEPLOY_PHASES = ["claimed", "running", "deployed", "unknown", "resolved"] as const;
export type DeployPhase = (typeof DEPLOY_PHASES)[number];
/** 部署任务可能还活着的阶段：挡 update，也挡再起一次部署 */
export const DEPLOY_IN_FLIGHT: readonly DeployPhase[] = ["claimed", "running"];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

const DEPLOY_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS scheduler_deploys (
    intentId TEXT PRIMARY KEY REFERENCES scheduler_intents(id), taskId TEXT NOT NULL REFERENCES tasks(id), project TEXT NOT NULL,
    prRef TEXT NOT NULL, mergeSha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN (${inList(DEPLOY_PHASES)})),
    rev INTEGER NOT NULL DEFAULT 1, label TEXT,
    outcome TEXT CHECK (outcome IN ('success','failed','unknown')), liveness TEXT CHECK (liveness IN ('dead')),
    receipt TEXT, reason TEXT, deployedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    CHECK (phase NOT IN ('deployed','unknown') OR COALESCE(liveness, '') = 'dead'),
    CHECK (phase <> 'deployed' OR COALESCE(outcome, '') = 'success'))`,
  "CREATE INDEX IF NOT EXISTS scheduler_deploys_project_phase ON scheduler_deploys(project, phase)",
];

export function DEPLOY_SCHEMA(db: Database): void {
  for (const sql of DEPLOY_SQL) db.prepare(sql).run();
}

export const DEPLOY_TABLES = ["scheduler_deploys"] as const;
export const DEPLOY_COLUMNS: Record<string, readonly string[]> = {
  scheduler_deploys: ["intentId", "taskId", "project", "prRef", "mergeSha", "phase", "rev", "label", "outcome", "liveness", "receipt", "reason", "deployedAt"],
};
export const DEPLOY_INDEXES: Record<string, readonly string[]> = { scheduler_deploys: ["scheduler_deploys_project_phase"] };

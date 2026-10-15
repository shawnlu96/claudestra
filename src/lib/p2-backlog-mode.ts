/**
 * 项目级独立开关 autostart.p2BacklogMode（agents-PMAUTO1；agents-PULLTODO1 起缺省 on，显式配置的照旧）：off 不做 / observe 只记本会入积压 / on 入积压后只发摘要。
 * 单独一个只读文件：调度侧的通知分流（p2-backlog-notice.ts）只需要读开关，不该顺带把积压 writer（p2-backlog.ts）拉进调度进程的依赖图。
 */
import type { Database } from "bun:sqlite";
import { readSwitch } from "./scheduler-autostart.js";

export type P2BacklogMode = "on" | "observe" | "off";
export const p2BacklogMode = (db: Database, project: string): P2BacklogMode => {
  const v = readSwitch(db, project).p2BacklogMode;
  return v === "observe" || v === "off" ? v : "on";
};

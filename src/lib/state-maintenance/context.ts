/**
 * 生产入口用的根:旧根 = 当前状态目录(CLAUDESTRA_STATE_DIR 覆盖了就是自定义根,STATE1 会按「未批准」拒绝),
 * 新根 = home 下的 .floka,维护根 = home 下的固定位置(不看状态目录覆盖)。manager、bridge、执行器都从这里取,规则只有一份。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { NEW_ROOT_NAME } from "../floka-migration/state/layout.js";
import { stateDirIn } from "../state-dir.js";
import { readRenamedEnv } from "../floka-env/read.js";
import { maintenanceRoot, prepareMaintenanceRoot, rootProblems, type MaintPaths } from "./paths.js";

export interface MaintContext { home: string; oldRoot: string; newRoot: string; maintRoot: string }

/** home 不给 = 本进程的真实 home;维护根此时走 maintenanceRoot() 的测试闸 */
export function productionContext(home?: string): MaintContext {
  const h = home ?? homedir();
  return { home: h, oldRoot: readRenamedEnv("STATE_DIR")?.trim() || stateDirIn(h), newRoot: join(h, NEW_ROOT_NAME), maintRoot: home ? maintenanceRoot(home) : maintenanceRoot() };
}

/** 维护根的问题(不建任何目录);状态按钮只读展示时用 */
export const contextProblems = (c: MaintContext): string[] => rootProblems(c.maintRoot, [c.oldRoot, c.newRoot]);

/** 校验后建维护根;有问题抛错,一个目录都不建 */
export const openMaintenance = (c: MaintContext): MaintPaths => prepareMaintenanceRoot(c.maintRoot, [c.oldRoot, c.newRoot]);

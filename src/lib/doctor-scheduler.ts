/** Scheduler-specific doctor row: the daemon may run correctly yet be deliberately inert. */
import { existsSync } from "node:fs";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import type { Check } from "./doctor.js";

export function checkSchedulerConfig(path = SCHEDULER_CONFIG_PATH): Check[] {
  const base = { group: "launchd daemon", name: "调度引擎配置" };
  if (!existsSync(path)) return [{ ...base, status: "warn", detail: "未配置；scheduler 服务空转",
    fix: `在 ${path} 写入 enabled、projects 与部署目标后重跑 doctor` }];
  try {
    const config = readSchedulerConfig(path);
    return config.enabled
      ? [{ ...base, status: "ok", detail: `已启用 ${Object.keys(config.projects).length} 个项目` }]
      : [{ ...base, status: "warn", detail: "配置已读取，但 enabled=false；scheduler 服务空转" }];
  } catch (e) {
    return [{ ...base, status: "fail", detail: `配置无效：${(e as Error).message}`, fix: `修复 ${path} 后重跑 doctor` }];
  }
}

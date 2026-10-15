/**
 * PMR-2 开关 `pmRails`：本机 recovery-policy.json 的 projects.<项目>.keys.pmRails（`ledger scheduler-recovery --key pmRails` 切），按项目各自生效。
 * 只认这个键的显式值，不继承项目整体 mode：on 会给 owner 推送，要 owner 自己批；没设 = observe（只在台账打标记）。
 * 文件坏 = off（和恢复策略一样保守停手，也不打标记）。从不抛。tests/pm-rails.test.ts。
 */
import type { PmRailsMode } from "./pm-rails.js";
import { readRecoveryFile, RECOVERY_POLICY_PATH } from "./recovery-policy.js";

export function pmRailsMode(project: string, path = RECOVERY_POLICY_PATH): PmRailsMode {
  const f = readRecoveryFile(path);
  if (f.status === "corrupt") return "off";
  if (f.status === "missing" || !Object.hasOwn(f.data.projects, project)) return "observe";
  return f.data.projects[project].keys?.pmRails ?? "observe";
}

/** 一次 CLI 调用内同一项目只读一次文件 */
export function cachedPmRailsMode(read: (project: string) => PmRailsMode = pmRailsMode): (project: string) => PmRailsMode {
  const seen = new Map<string, PmRailsMode>();
  return (project) => {
    let m = seen.get(project);
    if (m === undefined) { m = read(project); seen.set(project, m); }
    return m;
  };
}

/**
 * 出借方 B 往外发数据的开关（LENDUSAGE1 lendUsageReport、LENDUI2 lendUiUpload）共用的读法：本机 claudestra 仓库（REPO_ROOT）所属项目的
 * keys.<key> 显式值；没设、项目 mode 继承、文件坏、项目解析不出 = off。数据往外发，开不开由出借机的 owner 自己定，不继承项目整体 mode。
 * 同步读（交回正文在同步段里拼），从不抛。tests/lend-usage-report.test.ts、tests/lend-ui-submit.test.ts。
 */
import { readFileSync } from "node:fs";
import { PROJECTS_PATH, resolveProjectForRealDir, type ProjectDef } from "./projects.js";
import { isRecoveryMode, readRecoveryFile, RECOVERY_POLICY_PATH, type RecoveryKey, type RecoveryMode } from "./recovery-policy.js";
import { REPO_ROOT } from "./repo-root.js";

export interface ModeDeps { policyPath?: string; projectsPath?: string; repoRoot?: string }

export function explicitLendKeyMode(key: RecoveryKey, o: ModeDeps = {}): RecoveryMode {
  try {
    const projects = (JSON.parse(readFileSync(o.projectsPath ?? PROJECTS_PATH, "utf8")) as { projects?: ProjectDef[] }).projects;
    const project = Array.isArray(projects) ? resolveProjectForRealDir(projects, o.repoRoot ?? REPO_ROOT)?.id : undefined;
    if (!project) return "off";
    const f = readRecoveryFile(o.policyPath ?? RECOVERY_POLICY_PATH);
    if (f.status !== "ok" || !Object.hasOwn(f.data.projects, project)) return "off";
    const m = f.data.projects[project].keys?.[key];
    return isRecoveryMode(m) ? m : "off";
  } catch { return "off"; }
}

/** LENDUI2：出借交付带截图（lend submit 收图、出借服务上传、交付带清单）的开关 */
export const lendUiUploadMode = (o: ModeDeps = {}): RecoveryMode => explicitLendKeyMode("lendUiUpload", o);

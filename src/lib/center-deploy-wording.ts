/** Describe the route that is configured for this repository, preserving legacy receipts when its switch is off. */
import { readCenterDeployConfig } from "./center-deploy-config.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { cardRepo, projectRepo } from "./scheduler-foreign-repo.js";

export function deployWording(project: string, fallback: string, pr: string): string {
  try {
    const repo = cardRepo({ pr, extra: {} });
    if (recoveryPolicy(project, "centerDeployAuto").mode === "on" && readCenterDeployConfig()?.[project]?.repo.toLowerCase() === repo) {
      return "等中心部署授权（调度器已发卡）";
    }
    const p = readSchedulerConfig().projects[project], mode = recoveryPolicy(project, "deployMachineLock");
    return mode.mode !== "off" && p?.deploy && repo === projectRepo(p) ? "等调度器部署" : fallback;
  } catch { return fallback; /* Invalid routing configuration has no automatic deployment; retain the manual receipt. */ }
}

/** State-owned configuration: scripts are repository paths, never shell commands or host paths. */
import { isAbsolute } from "node:path";
import { statePath } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";

export interface CenterDeployConfig { repo: string; script: string; dryRunArgs: string[]; timeoutMinutes: number }
const CENTER_DEPLOY_CONFIG = statePath("center-deploy.json");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300 && !/[\p{Cc}\p{Cf}]/u.test(v);

export function centerScriptPath(v: unknown): string {
  if (!clean(v) || isAbsolute(v) || v.includes("\\") || v.split("/").some((p) => !p || p === "." || p === "..") || v.startsWith("-")) {
    throw new Error("中心部署脚本必须是仓内相对路径");
  }
  return v;
}

export function parseCenterDeployConfig(raw: unknown): Record<string, CenterDeployConfig> {
  if (!object(raw) || !object(raw.projects)) throw new Error("中心部署配置必须有 projects");
  const out: Record<string, CenterDeployConfig> = {};
  for (const [project, cfg] of Object.entries(raw.projects)) {
    if (!/^[\w.-]{1,80}$/.test(project) || !object(cfg) || typeof cfg.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)
      || !Array.isArray(cfg.dryRunArgs) || !cfg.dryRunArgs.length || cfg.dryRunArgs.length > 32 || !cfg.dryRunArgs.every(clean)
      || !Number.isInteger(cfg.timeoutMinutes) || Number(cfg.timeoutMinutes) < 1 || Number(cfg.timeoutMinutes) > 60) throw new Error("中心部署配置无效");
    out[project] = { repo: cfg.repo, script: centerScriptPath(cfg.script), dryRunArgs: cfg.dryRunArgs, timeoutMinutes: Number(cfg.timeoutMinutes) };
  }
  return out;
}

export function readCenterDeployConfig(path = CENTER_DEPLOY_CONFIG): Record<string, CenterDeployConfig> | null {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return null;
  if (r.status !== "ok") throw new Error("中心部署配置无法读取");
  return parseCenterDeployConfig(r.data);
}

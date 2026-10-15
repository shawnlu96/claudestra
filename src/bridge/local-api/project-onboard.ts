/**
 * 网页「接入编排」：POST /api/v1/projects/:id/onboard {localMerge?, checks?, maxWorkers?, dryRun}（ONB-3）。
 * 只转发给 `team onboard`（src/manager/team-onboard.ts）——核对、写段、出提案全在那条命令里，网页和终端走同一条路。
 * 要 manage 授权；dryRun 是打开面板时读清单用的。身份同 project-pm.ts：不带频道号 = owner。
 */
import { canManage } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { BUN_PATH, MANAGER_PATH, ENV_WITH_BUN } from "../config.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { ledgerProjectExists } from "./ledger.js";

interface OnboardApiDeps {
  exists(project: string): Promise<boolean>;
  run(args: string[]): Promise<Record<string, unknown>>;
}
const real: OnboardApiDeps = {
  exists: ledgerProjectExists,
  run: (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH,
    env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: undefined }, timeoutMs: 60_000 }),
};

interface Body { localMerge?: unknown; checks?: unknown; maxWorkers?: unknown; dryRun?: unknown }

/** 请求体 → `team onboard` 参数；不合法返回 null */
export function onboardArgs(project: string, b: Body): string[] | null {
  if (typeof b.dryRun !== "boolean" || (b.localMerge !== undefined && typeof b.localMerge !== "boolean")) return null;
  if (b.checks !== undefined && (typeof b.checks !== "string" || b.checks.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(b.checks))) return null;
  const n = b.maxWorkers;
  if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 32)) return null;
  const checks = typeof b.checks === "string" && b.checks.trim() ? [`--checks=${b.checks.trim()}`] : [];
  return ["team", "onboard", "--project", project, ...(b.localMerge ? ["--local-merge"] : []), ...checks,
    ...(n !== undefined ? [`--max-workers=${n}`] : []), ...(b.dryRun ? ["--dry-run"] : [])];
}

export async function handleProjectOnboardApi(req: Request, path: string, principal: Principal, deps: OnboardApiDeps = real): Promise<Response | null> {
  const m = /^\/projects\/([^/]+)\/onboard$/.exec(path);
  if (!m) return null;
  if (!canManage(principal)) return forbidden("project onboard requires manage authorization");
  if (req.method !== "POST") return apiJson(405, { error: "method not allowed" });
  let project: string;
  try { project = decodeURIComponent(m[1]!); }
  catch { return apiJson(400, { error: "invalid project encoding" }); }
  if (!/^[\w.-]{1,80}$/.test(project) || project.startsWith("-")) return apiJson(400, { error: "invalid project" });
  const body = await readJsonBody(req) as Body | typeof INVALID_JSON;
  if (body === INVALID_JSON) return invalidJsonBody();
  const args = body && typeof body === "object" ? onboardArgs(project, body) : null;
  if (!args) return apiJson(400, { error: "dryRun boolean required; localMerge boolean, checks string, maxWorkers 0..32 optional" });
  try {
    if (!(await deps.exists(project))) return apiJson(404, { error: "project not found" });
    const r = await deps.run(args);
    // 有清单就 200（ok:false 时清单里标着哪项拦住），网页照样渲染；没清单的才按错误码
    if (Array.isArray(r.items)) return apiJson(200, r);
    return apiJson(r.code === "forbidden" ? 403 : 400, r);
  } catch (e) {
    console.error("[project-onboard] request failed", e);
    return apiJson(503, { error: "project onboard unavailable" });
  }
}

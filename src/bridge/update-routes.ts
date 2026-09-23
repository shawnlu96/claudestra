/**
 * /api/v1/update* —— 网页「版本与更新」一节的全部后端：一键升级（点火即走）、升级日志、
 * 更新通道与自动更新开关、检查能升到哪个版本。都要全权 token。
 *
 * POST /update 与 GET /update/log 从 api-routes.ts 逐字搬来；settings / check 是新增。
 * 开关与通道只改 config.json（lib/config-store.ts，与 `manager auto-update` 同一写入口），
 * launcher 每轮巡检现读 config，所以改完下一轮就按新设置走，不用重启任何服务。
 */
import type { Principal } from "../lib/principals.js";
import { readConfig, setAutoUpdate, setUpdateChannel, type UpdateChannel } from "../lib/config-store.js";
import { checkUpdateStatus } from "../lib/update-status.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody } from "./api-respond.js";
import { activeBgJob, bgJobLog, bgJobLogResponse, spawnBgJob } from "./bg-jobs-http.js";

/** 不是 /update* 的请求回 null，交回 api-routes 继续匹配 */
export async function handleUpdateRoutes(req: Request, url: URL, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/update" && !path.startsWith("/update/")) return null;
  if (!isFullScope(principal)) return forbidden(path === "/update/log" ? "update log requires a full-scope token" : "update requires a full-scope token");

  /**
   * v2.24+ POST /api/v1/update —— 从网页一键升级（owner 2026-09-22）。
   *
   * ⚠ 必须 detached + 立刻 202：`manager update` 会 reload 三个 daemon，**包括正在
   * 处理这个请求的 bridge 自己**——等它返回就是等自己被杀，连接必断，前端只会看到
   * 一个无从区分的网络错误。所以这里只负责「点着火就走」，进度另开
   * GET /api/v1/update/log 拉。升级走哪条通道（release / beta）由 config 决定。
   */
  if (path === "/update" && req.method === "POST") {
    const busy = await activeBgJob("update");
    if (busy) return apiJson(409, { ok: false, error: "上一次升级还没结束", runId: busy });
    let runId: string;
    try {
      runId = spawnBgJob("update", "update", "update");
    } catch (e) {
      return apiJson(500, { ok: false, error: `起不来更新进程: ${(e as Error).message}` });
    }
    return apiJson(202, {
      ok: true,
      accepted: true,
      runId,
      log: bgJobLog("update"),
      hint: "升级中：三个 daemon 会依次重启，bridge 自己也在内。进度拉 GET /api/v1/update/log?run=<runId>",
    });
  }

  /** 升级进度（前端另外靠 /api/version 的 commit 变化兜底判完成） */
  if (path === "/update/log" && req.method === "GET") return bgJobLogResponse("update", url);

  if (path === "/update/settings" && req.method === "GET") {
    return apiJson(200, { ok: true, autoUpdate: settingsView((await readConfig()).autoUpdate) });
  }

  // POST {channel?: "release"|"beta", claudestra?: boolean, claudeCode?: boolean}：给了哪项改哪项
  if (path === "/update/settings" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const bad = settingsError(body);
    if (bad) return apiJson(400, { ok: false, error: bad });
    if (body.channel !== undefined) await setUpdateChannel(body.channel as UpdateChannel);
    if (body.claudestra !== undefined) await setAutoUpdate("claudestra", body.claudestra);
    if (body.claudeCode !== undefined) await setAutoUpdate("claudeCode", body.claudeCode);
    return apiJson(200, { ok: true, autoUpdate: settingsView((await readConfig()).autoUpdate) });
  }

  // 按当前通道查能升到哪个版本（要联网：GitHub API / git fetch，前端单独拉、别卡设置页）
  if (path === "/update/check" && req.method === "GET") {
    const channel = (await readConfig()).autoUpdate.channel ?? "release";
    return apiJson(200, { ok: true, ...(await checkUpdateStatus(channel)) });
  }

  return apiJson(404, { ok: false, error: `unknown update route ${req.method} ${path}` });
}

function settingsView(au: { claudestra: boolean; claudeCode: boolean; channel?: UpdateChannel }) {
  return { claudestra: au.claudestra, claudeCode: au.claudeCode, channel: au.channel ?? "release" };
}

/** 校验 settings 的 body（纯函数，tests/update-status.test.ts）；合法回 null */
export function settingsError(body: any): string | null {
  if (!body || typeof body !== "object") return "body must be an object";
  if (body.channel !== undefined && body.channel !== "release" && body.channel !== "beta") return 'channel must be "release" or "beta"';
  for (const k of ["claudestra", "claudeCode"]) {
    if (body[k] !== undefined && typeof body[k] !== "boolean") return `${k} must be a boolean`;
  }
  if (body.channel === undefined && body.claudestra === undefined && body.claudeCode === undefined) return "nothing to change";
  return null;
}

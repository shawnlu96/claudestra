/**
 * 「接受降档建议」的网页端口（TIER3b）：GET /settings/task-tier-lend 读；PUT { rev, acceptDowngrade } 改（rev CAS）。
 * 门 = owner 本人 + 全 scope manage 凭据（canRunFleet，经 lib/task-tier-lend-settings.ts tierLendEditProblem 同一判定）：
 * guest、部分 scope、peer（含远端 A）、agent 的 token 一律 403，门在读盘 / 读请求体之前判。写只经 saveTierLendSettings。
 * 对外错误是固定文案，底层原因（可能带本机路径）只进本机日志。tests/task-tier-lend-settings.test.ts。
 */
import { canRunFleet, type Principal } from "../../lib/principals.js";
import { readTierLendSettings, saveTierLendSettings, TIER_LEND_SETTINGS_PATH, type TierLendRead } from "../../lib/task-tier-lend-settings.js";
import { apiJson, forbidden } from "../api-respond.js";

const PATH = "/settings/task-tier-lend";
const BODY_MAX = 1_024;

export interface TierLendSettingsView { ok: true; status: TierLendRead["status"]; acceptDowngrade: boolean; rev: number }
const viewOf = (r: TierLendRead): TierLendSettingsView => ({ ok: true, status: r.status, acceptDowngrade: r.settings.acceptDowngrade, rev: r.settings.rev });

export interface TierLendSettingsDeps { path: string; now: () => number; log: (m: string) => void }

function parseBody(text: string): { rev: number; acceptDowngrade: boolean } | string {
  let b: unknown;
  try { b = JSON.parse(text); } catch { return "请求体要是 JSON 对象"; /* 坏 JSON 就是这个原因 */ }
  if (!b || typeof b !== "object" || Array.isArray(b)) return "请求体要是 JSON 对象";
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "rev" && k !== "acceptDowngrade")) return "只认 rev 与 acceptDowngrade";
  if (!Number.isInteger(o.rev) || (o.rev as number) < 0) return "rev 要是读到的版本号";
  if (typeof o.acceptDowngrade !== "boolean") return "acceptDowngrade 要是 true / false";
  return { rev: o.rev as number, acceptDowngrade: o.acceptDowngrade };
}

async function put(d: TierLendSettingsDeps, req: Request): Promise<Response> {
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  const body = parseBody(text);
  if (typeof body === "string") return apiJson(400, { ok: false, error: body });
  const r = saveTierLendSettings({ kind: "web", ownerFull: true }, body, d.now(), d.path);
  if (r.ok) return apiJson(200, viewOf({ status: "ok", settings: r.settings }));
  d.log(`⚠️ [task-tier-lend] 保存「接受降档建议」失败（${r.code}）：${r.error}`);
  if (r.code === "conflict") return apiJson(409, { ok: false, code: r.code, error: "设置刚被别处改过，已刷新为最新值", current: viewOf({ status: "ok", settings: r.current! }) });
  return apiJson(500, { ok: false, code: r.code, error: "保存失败，没有生效（详情见本机日志）" });
}

export function makeTierLendSettingsApi(deps: Partial<TierLendSettingsDeps> = {}) {
  const d: TierLendSettingsDeps = { path: TIER_LEND_SETTINGS_PATH, now: Date.now, log: (m) => console.warn(m), ...deps };
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== PATH) return null;
    if (!canRunFleet(principal)) return forbidden("only the owner's full-access device can view or change the downgrade-suggestion setting");
    if (req.method === "GET") {
      const read = readTierLendSettings(d.path);
      if (read.status === "invalid" || read.status === "unreadable") d.log(`⚠️ [task-tier-lend] 设置文件无效，按不接受降档执行：${read.error}`);
      return apiJson(200, viewOf(read));
    }
    if (req.method === "PUT") return put(d, req);
    return apiJson(405, { ok: false, error: "method not allowed" });
  };
}

/** local-api/index.ts FAMILIES 里挂的生产实例 */
export const handleTierLendSettingsApi = makeTierLendSettingsApi();

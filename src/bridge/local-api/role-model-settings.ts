/**
 * 模型档位表的网页端口（TIER1）：GET /settings/role-models 读表；PUT 改一个角色的一格（带读到的 rev，CAS）。
 * 门 = owner 本人 + 全 scope manage 凭据（canRunFleet）：guest、部分 scope、peer、agent 的 token 一律 403，门在读盘 / 读请求体之前判。
 * 写只经 lib/role-model-settings-save.ts saveRoleModels（唯一写入口）；坏值整份 400 不保存，别人先存了 409 并带回现表，读不了文件 500 不写。
 * 对外错误是固定文案，底层原因（可能带本机路径）只进本机日志。tests/role-model-settings-api.test.ts。
 */
import { CODEX_EFFORT_LEVELS } from "../../lib/codex-launch.js";
import { canRunFleet, type Principal } from "../../lib/principals.js";
import {
  CARD_ROLES, parseRoleModelPatch, readRoleModels, ROLE_MODEL_FAMILIES, ROLE_MODEL_SETTINGS_PATH, type RoleModelRead, type RoleModelTable,
} from "../../lib/role-model-settings.js";
import { saveRoleModels } from "../../lib/role-model-settings-save.js";
import { apiJson, forbidden } from "../api-respond.js";

const PATH = "/settings/role-models";
const BODY_MAX = 4_096;

export interface RoleModelSettingsView {
  ok: true;
  /** missing = 没存过、用默认表；invalid / unreadable = 文件坏了 / 读不了，正按默认表执行（error 是固定码） */
  config: { status: RoleModelRead["status"]; error: "config_invalid" | "config_unreadable" | null };
  rev: number;
  families: readonly string[];
  roles: { role: string; claude: string; codex: string | null }[];
  /** Codex 推理档的可选值（与启动器同一份清单）；Claude 模型清单网页从 useClaudeModels 拿 */
  codexEfforts: readonly string[];
  warning?: "replaced_invalid";
}

export interface RoleModelSettingsDeps { path: string; now: () => number; log: (m: string) => void }

const viewOf = (status: RoleModelRead["status"], t: RoleModelTable): RoleModelSettingsView => ({
  ok: true, config: { status, error: status === "invalid" ? "config_invalid" : status === "unreadable" ? "config_unreadable" : null },
  rev: t.rev, families: ROLE_MODEL_FAMILIES, roles: CARD_ROLES.map((role) => ({ role, ...t.roles[role] })), codexEfforts: CODEX_EFFORT_LEVELS,
});

const SAVE_ERRORS = {
  busy: "模型档位表正被别的请求修改，稍后再试",
  conflict: "这张表刚被别处改过，已刷新为最新值，请确认后再改",
  unreadable: "读不了模型档位表文件，没有保存（详情见本机日志）",
  io: "保存模型档位表失败，没有生效（详情见本机日志）",
} as const;

async function put(d: RoleModelSettingsDeps, req: Request): Promise<Response> {
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return apiJson(400, { ok: false, error: "请求体要是 JSON 对象" }); /* 坏 JSON 就是这个原因 */ }
  const patch = parseRoleModelPatch(body);
  if (typeof patch === "string") return apiJson(400, { ok: false, error: patch });
  const r = await saveRoleModels(patch, d.path, d.now());
  if (!r.ok) {
    d.log(`⚠️ [role-models] 保存模型档位表失败（${r.code}）：${r.error}`);
    const status = r.code === "busy" ? 503 : r.code === "conflict" ? 409 : 500;
    return apiJson(status, { ok: false, code: r.code, error: SAVE_ERRORS[r.code], ...(r.current ? { current: viewOf("ok", r.current) } : {}) });
  }
  if (r.replacedInvalid) d.log(`⚠️ [role-models] 原模型档位表损坏（${r.replacedInvalid}），已另存后按这次保存的内容重写`);
  return apiJson(200, { ...viewOf("ok", r.table), ...(r.replacedInvalid ? { warning: "replaced_invalid" } : {}) });
}

export function makeRoleModelSettingsApi(deps: Partial<RoleModelSettingsDeps> = {}) {
  const d: RoleModelSettingsDeps = { path: ROLE_MODEL_SETTINGS_PATH, now: Date.now, log: (m) => console.warn(m), ...deps };
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== PATH) return null;
    if (!canRunFleet(principal)) return forbidden("only the owner's full-access device can view or change role model settings");
    if (req.method === "GET") {
      const read = readRoleModels(d.path);
      if (read.status === "invalid" || read.status === "unreadable") d.log(`⚠️ [role-models] 模型档位表无效，按默认表执行：${read.error}`);
      return apiJson(200, viewOf(read.status, read.table));
    }
    if (req.method === "PUT") return put(d, req);
    return apiJson(405, { ok: false, error: "method not allowed" });
  };
}

export const handleRoleModelSettingsApi = makeRoleModelSettingsApi();

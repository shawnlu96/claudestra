/**
 * 出借面板的「Claude 登录」状态：本机 Claude Code 登录能否接单 + 旧 setup-token 的残留位置。只读；setup-token 已下线，写入一律 405。
 * owner / 全权设备闸在任何 IO 之前。`configured` 留给还没刷新的旧网页包（它按这个字段显示）。
 */
import { canReadLedger } from "../../lib/devices.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { legacyClaudeToken } from "../../lib/lend-claude-token.js";
import { freshClaudeReadiness } from "../../lib/lend-claude-worker-capacity.js";
import { apiJson, forbidden } from "../api-respond.js";

export function makeLendClaudeTokenApi(deps = { readiness: () => freshClaudeReadiness(), legacy: () => legacyClaudeToken() }) {
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== "/lend/claude-token") return null;
    if (!isOwnerPrincipal(principal) || !canReadLedger(principal)) return forbidden("only the owner (full-access device) can manage lending");
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "setup-token 已下线：出借 Claude 直接用本机 Claude Code 登录" });
    try {
      const r = await deps.readiness();
      const legacy = deps.legacy();
      return apiJson(200, { loggedIn: r.ready, reason: r.reason, legacyTokenFile: legacy.file, legacyTokenEnv: legacy.envVar,
        configured: r.ready, savedAt: null });
    } catch (e) {
      console.error(`[lend] Claude 登录状态读取失败：${(e as Error).message}`);
      return apiJson(503, { ok: false, error: "claude login status unavailable" });
    }
  };
}
export const handleLendClaudeTokenApi = makeLendClaudeTokenApi();

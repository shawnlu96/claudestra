/** Owner/full-device gate precedes body reads and credential IO. Errors never include request or filesystem contents. */
import { canReadLedger } from "../../lib/devices.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { claudeTokenStatus, saveClaudeToken } from "../../lib/lend-claude-token.js";
import { apiJson, forbidden } from "../api-respond.js";
const MAX = 16_384;

async function tokenBody(req: Request): Promise<string | Response> {
  if (Number(req.headers.get("content-length")) > MAX) return apiJson(413, { ok: false });
  const reader = req.body?.getReader();
  if (!reader) return apiJson(400, { ok: false });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX) { await reader.cancel(); return apiJson(413, { ok: false }); }
      chunks.push(value);
    }
    const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof b.token === "string" && b.token.trim() && b.token.trim().length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(b.token.trim())) return b.token.trim();
  } catch {
    // Invalid JSON or an interrupted stream is rejected without echoing sensitive input.
  } finally { reader.releaseLock(); }
  return apiJson(400, { ok: false, error: "invalid setup-token" });
}

export function makeLendClaudeTokenApi(deps = { status: claudeTokenStatus, save: saveClaudeToken }) {
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== "/lend/claude-token") return null;
    if (!isOwnerPrincipal(principal) || !canReadLedger(principal)) return forbidden("only the owner (full-access device) can manage lending");
    try {
      if (req.method === "GET") return apiJson(200, deps.status());
      if (req.method === "DELETE") return apiJson(200, await deps.save(null));
      if (req.method !== "POST") return apiJson(405, { ok: false });
      const token = await tokenBody(req);
      return token instanceof Response ? token : apiJson(200, await deps.save(token));
    } catch {
      // Credential IO failures are actionable through status only; filesystem errors may expose secrets.
      return apiJson(503, { ok: false, error: "credential storage unavailable" });
    }
  };
}
export const handleLendClaudeTokenApi = makeLendClaudeTokenApi();

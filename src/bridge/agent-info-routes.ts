/**
 * /api/v1/agents/:name/info（GET）与 /api/v1/agents/:name/external（POST）——web「会话详情」弹窗的后端
 * （owner 2026-09-27）。只给全权 token：详情里有本机路径 / sessionId / Discord 频道，peer 不该看到。
 * 关闭 external 时若该 agent 正在某个 peer 的 scope 里，必须带 confirm=<会话名> 才执行（前端要求输入会话名），
 * 否则 409 并回 sharedWith 让前端弹确认。改动本身走 runManager("external")，bridge 不直写 registry。
 */
import type { Principal } from "../lib/principals.js";
import { readPrincipals } from "../lib/principals.js";
import { readRegistryAgents } from "../lib/registry.js";
import { peersSharingAgent } from "../lib/peer-scope-gate.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody } from "./api-respond.js";

type RunManager = (...args: string[]) => Promise<any>;

export async function handleAgentInfoRoutes(req: Request, path: string, principal: Principal, runManager: RunManager): Promise<Response | null> {
  const m = path.match(/^\/agents\/([^/]+)\/(info|external)$/);
  if (!m) return null;
  if (!isFullScope(principal)) return forbidden(`agent ${m[2]} requires a full-scope token`);
  const bare = decodeURIComponent(m[1]).replace(/^agent-/, "");
  if (bare === "master") return apiJson(400, { ok: false, error: "master has no registry details" });
  const [agents, pf] = await Promise.all([readRegistryAgents(), readPrincipals()]);
  const a = agents.find((x) => x.name === `agent-${bare}` || x.name === bare);
  if (!a) return apiJson(404, { ok: false, error: `agent "${bare}" not found` });
  const sharedWith = peersSharingAgent(pf.principals, bare);
  if (m[2] === "info" && req.method === "GET") {
    const raw = a as unknown as Record<string, unknown>;
    return apiJson(200, {
      ok: true,
      agent: {
        name: bare,
        displayName: a.displayName ?? null,
        purpose: a.purpose ?? "",
        cwd: a.cwd ?? null,
        status: a.status ?? null,
        sessionId: a.sessionId ?? null,
        channelId: a.channelId ?? null,
        projectId: a.projectId ?? null,
        runtime: a.runtime ?? "claude-code",
        model: a.model ?? null,
        effort: a.effort ?? null,
        created: typeof raw.created === "string" ? raw.created : null,
        external: a.external === true,
        sharedWith,
      },
    });
  }
  if (m[2] === "external" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const on = body?.on === true;
    if (!on && sharedWith.length && String(body?.confirm ?? "") !== bare) {
      return apiJson(409, { ok: false, error: `agent "${bare}" 正共享给 peer：${sharedWith.join(", ")}——关闭需输入会话名确认`, sharedWith, needConfirm: true });
    }
    const r = await runManager("external", bare, on ? "on" : "off");
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}

/**
 * /api/v1/agents/:name/info（GET）、/external（POST）、/label（POST，显示名）——web「会话详情」弹窗的后端
 * （owner 2026-09-27）。只给全权且非 peer 的 token：详情里有本机路径 / sessionId / Discord 频道，peer 不该看到
 * （老版本能给 peer 签 "*" scope，只看 isFullScope 会把这种历史 token 放进来）。
 * 关闭 external 时若该 agent 正在某个 peer 的 scope 里，必须带 confirm=<会话名>（逐字符相等）才执行，
 * 否则 409 并回 sharedWith 让前端弹确认。改动本身走 runManager("external")，bridge 不直写 registry。
 * registry / principals 的读取可注入：tests/agent-info-routes.test.ts 用假数据覆盖鉴权与确认分支。
 */
import { existsSync } from "node:fs";
import { USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import type { Principal, PrincipalsFile } from "../lib/principals.js";
import { readPrincipals } from "../lib/principals.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { peersSharingAgent } from "../lib/peer-scope-gate.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody } from "./api-respond.js";

type RunManager = (...args: string[]) => Promise<any>;

export interface AgentInfoIo {
  readRegistryAgents: () => Promise<RegistryAgent[]>;
  readPrincipals: () => Promise<PrincipalsFile>;
}
const defaultIo: AgentInfoIo = { readRegistryAgents: () => readRegistryAgents(), readPrincipals: () => readPrincipals() };

/** GET /agents 每一行的附加字段：external 闸门、显示名、已归档；「共享给几个 peer」只给全权非 peer（与详情同一道门） */
export type AgentListExtras = (name: string, r?: { external?: boolean; label?: string }) => Record<string, unknown>;

/**
 * 已归档：归档区里有这个 agent 的目录 ⇒ 网页把它从工作列表隐藏（归档 = 收起来，不是删掉；恢复时目录被清掉，自然回到列表）。
 * 不靠 kill：列表本来就包含已停止的 agent（灰点），光停窗口移不出去。sharedPeers 对 peer / 受限 token 不给——谁在共享是 owner 的事。
 */
export async function agentListExtras(principal: Principal, io: Pick<AgentInfoIo, "readPrincipals"> = defaultIo): Promise<AgentListExtras> {
  const full = isFullScope(principal) && !principal.peer;
  const principals = full ? (await io.readPrincipals()).principals : [];
  const archived = (name: string) => existsSync(`${USER_ARCHIVE_ROOT}/${name.replace(/^agent-/, "")}`);
  return (name, r) => ({
    external: r?.external === true,
    label: r?.label ?? null,
    archived: archived(name),
    ...(full ? { sharedPeers: peersSharingAgent(principals, name).length } : {}),
  });
}

export async function handleAgentInfoRoutes(
  req: Request,
  path: string,
  principal: Principal,
  runManager: RunManager,
  io: AgentInfoIo = defaultIo,
): Promise<Response | null> {
  const m = path.match(/^\/agents\/([^/]+)\/(info|external|label)$/);
  if (!m) return null;
  if (!isFullScope(principal) || principal.peer) return forbidden(`agent ${m[2]} requires a full-scope (non-peer) token`);
  const bare = decodeURIComponent(m[1]).replace(/^agent-/, "");
  if (bare === "master") return apiJson(400, { ok: false, error: "master has no registry details" });
  const [agents, pf] = await Promise.all([io.readRegistryAgents(), io.readPrincipals()]);
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
        label: a.label ?? null,
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
  if (m[2] === "label" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    if (typeof body?.label !== "string") return apiJson(400, { ok: false, error: '"label" (string) required' });
    const r = await runManager("label", bare, body.label);
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}

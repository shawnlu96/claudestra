/**
 * /api/v1/peers* —— HTTP peer 管理面（从 api-routes.ts 原样搬出，给大文件腾行数）。
 * runManager 由调用方注入：它在 management.ts（hub），bridge 模块不能反向 import。
 */
import type { Principal } from "../lib/principals.js";
import { readPrincipals, tokenIdOf } from "../lib/principals.js";
import { readPeers } from "../lib/peers.js";
import { readRegistryAgents } from "../lib/registry.js";
import { recordMetric } from "../lib/metrics.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody } from "./api-respond.js";

type RunManager = (...args: string[]) => Promise<any>;

// ── v2.11.1+ /peers —— HTTP peer 管理面（web UI 后端;owner 2026-07-24
// 「前端要能管理 peer 的权限以及在哪些远端有权限」）。全部 mutation 走
// runManager 复用 CLI 的 R1 校验/token 签发/原子写,bridge 不直写 principals。
export async function handlePeersRoutes(req: Request, path: string, principal: Principal, runManager: RunManager): Promise<Response | null> {
  if (path !== "/peers" && !path.startsWith("/peers/")) return null;
  if (!isFullScope(principal)) return forbidden("peers management requires a full-scope token");
  if (path === "/peers" && req.method === "GET") return listPeers(runManager);
  // POST /peers/tidy —— 把同一个对方散成的多条旧记录合成一条（lib/peer-tidy.ts；GET /peers 的 tidy 字段是预览）
  if (path === "/peers/tidy" && req.method === "POST") {
    const r = await runManager("peer-http-tidy", "--apply");
    if (r?.ok && r.applied) recordMetric("peer_managed", { meta: { action: "tidy", peer: (r.peers || []).join(",") } });
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  // POST /peers/inspect —— 加入前先看一眼：能不能连到对方、加入后能找哪些 agent（只读，不兑换）
  if (path === "/peers/inspect" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const invite = String(body?.invite ?? "").trim();
    if (!invite) return apiJson(400, { ok: false, error: '"invite" required' });
    const r = await runManager("peer-invite-inspect", invite);
    return apiJson(200, r ?? { ok: false, error: "manager failed" }); // 连不上是数据不是服务错，同 /test
  }
  if (req.method === "POST" && (path === "/peers/invite-new" || path === "/peers/join-auto" || path === "/peers/invite-revoke")) {
    return inviteAction(req, path, runManager);
  }
  if (req.method === "POST" && (path === "/peers/invite" || path === "/peers/join" || path === "/peers/accept")) {
    return legacyHandshake(req, path, runManager);
  }
  const peerActionMatch = path.match(/^\/peers\/([^/]+)\/(test|scope|remove)$/);
  if (peerActionMatch && req.method === "POST") return peerAction(req, peerActionMatch, runManager);
  return apiJson(404, { ok: false, error: "unknown peers endpoint" });
}

// GET /peers —— 清单:peers.json ⋈ principals(入站 scope) + 本地 agent 表(scope 编辑器数据源)
async function listPeers(runManager: RunManager): Promise<Response> {
  const [peersData, pf, regAgents] = await Promise.all([
    readPeers(),
    readPrincipals(),
    readRegistryAgents(),
  ]);
  const { peerPresence } = await import("./peer-presence.js");
  const peers = (peersData.httpPeers || []).map((p) => {
    const tok = pf.principals.find((x) => x.peer === p.name && !x.disabled);
    return {
      name: p.name,
      baseUrl: p.baseUrl || null,
      handshakeDone: !!(p.outToken && p.baseUrl),
      disabled: !!p.disabled,
      addedAt: p.addedAt,
      inTokenId: tok ? tokenIdOf(tok) : p.inTokenId ?? null,
      /** 对方 token 的 scope = 对方能访问我这边哪些 agent */
      exposedAgents: tok?.agents ?? [],
      presence: peerPresence(p.name), // 在线状态 + 最近来访（bridge/peer-presence.ts）
    };
  });
  const localAgents = regAgents.map((a) => ({
    name: a.name.startsWith("agent-") ? a.name.slice(6) : a.name,
    external: !!a.external,
    status: a.status ?? "unknown",
  }));
  // v2.15+ 待兑换的一键邀请（peer-invite-list 顺带清扫过期 + 吊销其 token）
  const invRes: any = await runManager("peer-invite-list");
  const pendingInvites = invRes?.ok ? invRes.invites || [] : [];
  const { activePeerTokens, planPeerTidy } = await import("../lib/peer-tidy.js"); // 重复 / 没用的旧记录，面板顶部给「整理」
  // 近 7 天的交接汇总（lib/handoff-log.ts）：面板顶部一行数字 + 每张卡片自己的次数
  const { readHandoffs, summarizeHandoffs } = await import("../lib/handoff-log.js");
  const since = Date.now() - 7 * 86400_000;
  const handoffs = summarizeHandoffs(await readHandoffs(since), since);
  return apiJson(200, { ok: true, peers, localAgents, pendingInvites, handoffs, tidy: planPeerTidy(peersData.httpPeers || [], activePeerTokens(pf.principals)) });
}

// v2.15+ POST /peers/invite-new | /peers/join-auto | /peers/invite-revoke
// —— 一键邀请（免回执自动握手）。mutation 照旧全部委托 runManager。
async function inviteAction(req: Request, path: string, runManager: RunManager): Promise<Response> {
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const agentsCsv = Array.isArray(body?.agents)
    ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
    : "";
  const flags: string[] = body?.force ? ["--force"] : [];
  let r: any;
  if (path === "/peers/invite-new") {
    if (!agentsCsv) return apiJson(400, { ok: false, error: '"agents" must be a non-empty array' });
    r = await runManager("peer-invite-new", "--agents", agentsCsv,
      ...(body?.url ? ["--url", String(body.url)] : []), ...flags);
  } else if (path === "/peers/join-auto") {
    const invite = String(body?.invite ?? "").trim();
    if (!invite) return apiJson(400, { ok: false, error: '"invite" required' });
    r = await runManager("peer-join-auto", invite,
      ...(agentsCsv ? ["--agents", agentsCsv] : []),
      ...(body?.url ? ["--url", String(body.url)] : []), ...flags);
  } else {
    const id = String(body?.id ?? "").trim();
    if (!id) return apiJson(400, { ok: false, error: '"id" required' });
    r = await runManager("peer-invite-revoke", id);
  }
  if (r?.ok) recordMetric("peer_managed", { meta: { action: path.slice("/peers/".length), peer: r.peer ?? r.id ?? r.revoked ?? "" } });
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

// POST /peers/invite | /peers/join | /peers/accept —— 握手三步
async function legacyHandshake(req: Request, path: string, runManager: RunManager): Promise<Response> {
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return apiJson(400, { ok: false, error: '"name" required' });
  const agentsCsv = Array.isArray(body?.agents)
    ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
    : "";
  const flags: string[] = [];
  if (body?.force) flags.push("--force");
  if (body?.rotate) flags.push("--rotate");
  let r: any;
  if (path === "/peers/invite") {
    r = await runManager("peer-http-invite", name, "--agents", agentsCsv, "--url", String(body?.url ?? ""), ...flags);
  } else if (path === "/peers/join") {
    r = await runManager("peer-http-join", name, String(body?.invite ?? ""), "--agents", agentsCsv, "--url", String(body?.url ?? ""), ...flags);
  } else {
    r = await runManager("peer-http-accept", name, String(body?.receipt ?? ""));
  }
  if (r?.ok) recordMetric("peer_managed", { meta: { action: path.slice("/peers/".length), peer: name } });
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

// POST /peers/:name/test | /peers/:name/scope | /peers/:name/remove
async function peerAction(req: Request, peerActionMatch: RegExpMatchArray, runManager: RunManager): Promise<Response> {
  const pname = decodeURIComponent(peerActionMatch[1]);
  const action = peerActionMatch[2];
  if (action === "test") {
    // 连通探测(顺带回答「我在对方那边有哪些 agent 可访问」)。失败也是数据不是服务错,一律 200
    const r = await runManager("peer-http-test", pname);
    return apiJson(200, r ?? { ok: false, error: "manager failed" });
  }
  if (action === "remove") {
    const r = await runManager("peer-http-remove", pname);
    if (r?.ok) recordMetric("peer_managed", { meta: { action: "remove", peer: pname } });
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  // scope —— 改对方入站可访问的 agent 白名单(R1 校验在 manager 侧)
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const agentsCsv = Array.isArray(body?.agents)
    ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
    : "";
  if (!agentsCsv) return apiJson(400, { ok: false, error: '"agents" must be a non-empty array' });
  const r = await runManager("peer-http-scope", pname, "--agents", agentsCsv, ...(body?.force ? ["--force"] : []));
  if (r?.ok) recordMetric("peer_managed", { meta: { action: "scope", peer: pname, agents: agentsCsv } });
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

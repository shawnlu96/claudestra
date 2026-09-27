/**
 * 按 agent / 按 skill 的前端偏好（原 web BFF 的 agents/settings、chat/messages/hide、skills/prefs 路由），都存 web 状态库：
 *   GET/PUT  /api/v1/agents/:name/settings     { initMessage: string|null }（clear 后自动发送的开机指令；PUT null = 清除）
 *   GET/POST /api/v1/agents/:name/hidden       { ranges:[{sessionId, fromSeq, toSeq}] }；POST { sessionId, fromSeq, toSeq, hide }
 *   GET /api/v1/skills/prefs · PUT /api/v1/skills/prefs/:name {pinned} · POST /api/v1/skills/prefs/:name/used → { prefs:[{name, pinned, usedCount}] }
 * agent 名按路径参数原样存（与 T5 前端约定，"master" 就是 "master"）；agent 端点要凭据的 agent scope，skill 偏好任何凭据都能改。
 * 「隐藏」只是聊天记录视图层的跨设备状态，不动会话 jsonl。
 */
import type { Principal } from "../../lib/principals.js";
import { apiJson, inScopeEitherName, INVALID_JSON, invalidJsonBody, notInScope, readJsonBody } from "../api-respond.js";
import { webDb } from "./db.js";

const AGENT_RE = /^\/agents\/([^/]+)\/(settings|hidden)$/;
const SKILL_RE = /^\/skills\/prefs\/([^/]+)(\/used)?$/;
const SKILL_NAME_RE = /^[\w:-]{1,64}$/;
/** Pi 会话 id 可以不是 UUID；只挡分隔符 / 空白 */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,79}$/;
const MAX_RANGE = 10_000;

export async function handleAgentPrefs(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/skills/prefs" && req.method === "GET") return apiJson(200, { ok: true, prefs: listSkillPrefs() });
  const s = path.match(SKILL_RE);
  if (s) return skillPref(req, decodeURIComponent(s[1]), !!s[2]);
  const m = path.match(AGENT_RE);
  if (!m) return null;
  const agent = decodeURIComponent(m[1]);
  if (!inScopeEitherName(principal, agent)) return notInScope(agent);
  if (m[2] === "settings") {
    if (req.method === "GET") return apiJson(200, { ok: true, initMessage: readInitMessage(agent) });
    return req.method === "PUT" ? putInitMessage(req, agent) : null;
  }
  if (req.method === "GET") return apiJson(200, { ok: true, ranges: hiddenRanges(agent) });
  return req.method === "POST" ? postHidden(req, agent) : null;
}

// ── agent_settings ──────────────────────────────────────────────────────

function readInitMessage(agent: string): string | null {
  const row = webDb().prepare("SELECT init_message FROM agent_settings WHERE agent = ?").get(agent) as { init_message: string } | null;
  return row?.init_message ?? null;
}

async function putInitMessage(req: Request, agent: string): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const v = (body as { initMessage?: unknown } | null)?.initMessage;
  if (v !== null && typeof v !== "string") return apiJson(400, { ok: false, error: "initMessage must be a string or null" });
  if (v === null) webDb().prepare("DELETE FROM agent_settings WHERE agent = ?").run(agent);
  else {
    webDb().prepare(
      "INSERT INTO agent_settings (agent, init_message, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET init_message = excluded.init_message, updated_at = excluded.updated_at",
    ).run(agent, v, new Date().toISOString());
  }
  return apiJson(200, { ok: true, initMessage: readInitMessage(agent) });
}

// ── hidden_messages ─────────────────────────────────────────────────────

interface HiddenRange {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
}

function hiddenRanges(agent: string): HiddenRange[] {
  return webDb().prepare("SELECT session_id AS sessionId, seq_from AS fromSeq, seq_to AS toSeq FROM hidden_messages WHERE agent = ? ORDER BY session_id, seq_from").all(agent) as HiddenRange[];
}

async function postHidden(req: Request, agent: string): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const b = (body ?? {}) as { sessionId?: unknown; fromSeq?: unknown; toSeq?: unknown; hide?: unknown };
  const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim() : "";
  if (!SESSION_RE.test(sessionId)) return apiJson(400, { ok: false, error: "sessionId required" });
  const from = Number(b.fromSeq);
  const to = b.toSeq == null ? from : Number(b.toSeq);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > MAX_RANGE) return apiJson(400, { ok: false, error: "bad seq range" });
  if (b.hide === false) webDb().prepare("DELETE FROM hidden_messages WHERE agent = ? AND session_id = ? AND seq_from = ?").run(agent, sessionId, from);
  else {
    webDb().prepare(
      `INSERT INTO hidden_messages (agent, session_id, seq_from, seq_to, hidden_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent, session_id, seq_from) DO UPDATE SET seq_to = excluded.seq_to, hidden_at = excluded.hidden_at`,
    ).run(agent, sessionId, from, to, Date.now());
  }
  return apiJson(200, { ok: true, ranges: hiddenRanges(agent) });
}

// ── skill_prefs ─────────────────────────────────────────────────────────

interface SkillPref {
  name: string;
  pinned: boolean;
  usedCount: number;
  updatedAt: string;
}

/** 置顶的排前面、按置顶时间；其余按使用频次 */
function listSkillPrefs(): SkillPref[] {
  const rows = webDb().prepare("SELECT name, pinned, used_count, updated_at FROM skill_prefs").all() as { name: string; pinned: number; used_count: number; updated_at: string }[];
  return rows
    .map((r) => ({ name: r.name, pinned: r.pinned === 1, usedCount: r.used_count, updatedAt: r.updated_at }))
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.pinned ? a.updatedAt.localeCompare(b.updatedAt) : b.usedCount - a.usedCount));
}

async function skillPref(req: Request, name: string, used: boolean): Promise<Response | null> {
  if (!SKILL_NAME_RE.test(name)) return apiJson(400, { ok: false, error: "bad skill name" });
  const now = new Date().toISOString();
  if (used && req.method === "POST") {
    webDb().prepare("INSERT INTO skill_prefs (name, pinned, used_count, updated_at) VALUES (?, 0, 1, ?) ON CONFLICT(name) DO UPDATE SET used_count = used_count + 1").run(name, now);
  } else if (!used && req.method === "PUT") {
    const body = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const pinned = (body as { pinned?: unknown } | null)?.pinned;
    if (typeof pinned !== "boolean") return apiJson(400, { ok: false, error: "pinned must be a boolean" });
    webDb().prepare(
      "INSERT INTO skill_prefs (name, pinned, used_count, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(name) DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at",
    ).run(name, pinned ? 1 : 0, now);
  } else return null;
  return apiJson(200, { ok: true, prefs: listSkillPrefs() });
}

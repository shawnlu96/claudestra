/**
 * 图片与文件（媒体索引）端点：
 *   GET /api/v1/media?agent=&kind=image|file&q=&dir=in|out&cat=&since=&until=&before=|after=&limit=
 *   GET /api/v1/media?…&around=<媒体 id> | &name=<气泡里的文件名>[&session=&seq=]   —— 大图查看器取一窗
 *   GET /api/v1/media/:id/raw[?display=1]   GET /api/v1/media/:id/thumb
 * 口径与 /history、/history/search 相同：候选 agent = registry + 归档目录 + master，再按 token scope 过滤；
 * 取文件按索引行的 agent 核 scope，歧义 / 跨 agent 认领的行只给 manage（lib/media-query.ts isRestricted）。
 * 索引首建可能很久：请求最多等 BUILD_WAIT_MS，没建完就先回已有的并带 building:true，前端稍后再拉。
 */
import { readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { attachmentMime } from "../../lib/attachment-lookup.js";
import { canManage } from "../../lib/devices.js";
import { openMediaIndex, refreshMediaIndex, type MediaSource } from "../../lib/media-index.js";
import { findAnchor, isRestricted, mediaRow, queryAround, queryMedia, type MediaFilter } from "../../lib/media-query.js";
import { openLoc } from "../../lib/media-store.js";
import { convertedImage } from "../../lib/media-thumb.js";
import { ARCHIVE_ROOT, statePath } from "../../lib/paths.js";
import { agentInScope, type Principal } from "../../lib/principals.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { listAgentSessions } from "../../lib/session-history.js";
import { apiJson } from "../api-respond.js";
import { MASTER_DIR } from "../config.js";
import { latestSessionIdForCwd } from "../session-ids.js";
import { attachmentDirs } from "./attachments.js";

const REFRESH_EVERY_MS = 10_000;
const BUILD_WAIT_MS = 3_000;
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

interface AgentInfo {
  name: string;
  cwd?: string;
  sessionId?: string;
  runtime?: string;
}

const paths = { db: statePath("media-index.sqlite"), thumbs: statePath("media-thumbs") };
let agentsProvider: () => Promise<AgentInfo[]> = defaultAgents;
let sourcesProvider: (agents: AgentInfo[]) => Promise<MediaSource[]> = sourcesOf;
/** 单测：库 / 缩略图目录指到临时路径，agent 清单与会话文件清单换成桩 */
export function setMediaForTest(
  o: { db?: string; thumbs?: string; agents?: () => Promise<AgentInfo[]>; sources?: (agents: AgentInfo[]) => Promise<MediaSource[]> } | undefined,
): void {
  paths.db = o?.db ?? statePath("media-index.sqlite");
  paths.thumbs = o?.thumbs ?? statePath("media-thumbs");
  agentsProvider = o?.agents ?? defaultAgents;
  sourcesProvider = o?.sources ?? sourcesOf;
  lastRefresh.clear();
  inflight = null;
}

async function defaultAgents(): Promise<AgentInfo[]> {
  const reg = await readRegistryAgents();
  const out: AgentInfo[] = reg.map((a) => ({ name: a.name, cwd: a.cwd, sessionId: a.sessionId, runtime: a.runtime }));
  const known = new Set(out.map((a) => a.name));
  try {
    for (const d of readdirSync(ARCHIVE_ROOT, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== "master" && !known.has(d.name)) out.push({ name: d.name });
    }
  } catch {
    /* 归档目录不存在 = 没有已删 agent 的归档 */
  }
  out.push({ name: "master", cwd: MASTER_DIR, sessionId: latestSessionIdForCwd(MASTER_DIR, "claude-code") });
  return out;
}

const lastRefresh = new Map<string, number>();
let inflight: Promise<void> | null = null;

async function sourcesOf(agents: AgentInfo[]): Promise<MediaSource[]> {
  const out: MediaSource[] = [];
  for (const a of agents) {
    const sessions = await listAgentSessions(a.name, { cwd: a.cwd, currentSessionId: a.sessionId, runtime: a.runtime });
    for (const s of sessions) out.push({ agent: a.name, sessionId: s.sessionId, path: s.path });
  }
  return out;
}

/** 刷新到期的 agent；同一时刻只跑一轮，后来的请求等同一轮（刚刷过的 agent 10 秒内不再扫） */
function refresh(db: Database, agents: AgentInfo[]): Promise<void> {
  const run = async () => {
    const now = Date.now();
    const due = agents.filter((a) => now - (lastRefresh.get(a.name) ?? 0) >= REFRESH_EVERY_MS);
    if (!due.length) return;
    for (const a of due) lastRefresh.set(a.name, now);
    await refreshMediaIndex(db, await sourcesProvider(due), attachmentDirs(), now);
  };
  const next: Promise<void> = (inflight ?? Promise.resolve()).then(run).catch((e) => {
    console.error("[media] 索引刷新失败:", (e as Error).message);
  }).finally(() => {
    if (inflight === next) inflight = null;
  });
  inflight = next;
  return next;
}

/** 调用方 scope 内的 agent；指定了 agent 就只要它（不在 scope → null = 403） */
async function scopedAgents(principal: Principal, want: string | null): Promise<AgentInfo[] | null> {
  const all = (await agentsProvider()).filter((a) => agentInScope(principal, a.name));
  if (!want) return all;
  const hit = all.find((a) => a.name === want || a.name === `agent-${want}`);
  return hit ? [hit] : null;
}

function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function filterOf(url: URL, agents: string[]): MediaFilter {
  const p = url.searchParams;
  const kind = p.get("kind");
  const dir = p.get("dir");
  const cat = p.get("cat");
  return {
    agents,
    kind: kind === "image" || kind === "file" ? kind : undefined,
    dir: dir === "in" || dir === "out" ? dir : undefined,
    cat: cat && /^[a-z]{1,12}$/.test(cat) ? cat : undefined,
    q: (p.get("q") || "").trim().slice(0, 100) || undefined,
    since: num(p.get("since")),
    until: num(p.get("until")),
  };
}

async function listMedia(url: URL, principal: Principal): Promise<Response> {
  const agents = await scopedAgents(principal, url.searchParams.get("agent"));
  if (!agents) return apiJson(403, { ok: false, error: "agent not in token scope" });
  const db = openMediaIndex(paths.db);
  const job = refresh(db, agents);
  const building = !(await Promise.race([job.then(() => true), Bun.sleep(BUILD_WAIT_MS).then(() => false)]));
  const f = filterOf(url, agents.map((a) => a.name));
  const manage = canManage(principal);
  const limit = Math.max(1, Math.min(200, Math.floor(num(url.searchParams.get("limit")) ?? 60)));
  const p = url.searchParams;
  if (p.get("around") || p.get("name")) {
    const anchor = findAnchor(db, f, { id: p.get("around") || undefined, name: p.get("name") || undefined, sessionId: p.get("session") || undefined, seq: num(p.get("seq")) });
    if (!anchor) return apiJson(404, { ok: false, error: "media not found", building });
    return apiJson(200, { ok: true, building, ...queryAround(db, f, anchor, Math.ceil(limit / 2), manage) });
  }
  return apiJson(200, { ok: true, building, ...queryMedia(db, f, { before: p.get("before"), after: p.get("after"), limit, manage }) });
}

async function serveFile(id: string, variant: "raw" | "thumb", display: boolean, principal: Principal): Promise<Response> {
  const db = openMediaIndex(paths.db);
  const row = mediaRow(db, id);
  // 不在 scope 与不存在同样回 404：不让人按 id 探测别的 agent 有没有这个文件
  if (!row || !agentInScope(principal, row.agent)) return apiJson(404, { ok: false, error: "media not found" });
  if (isRestricted(row, canManage(principal))) return apiJson(403, { ok: false, error: "media restricted (ambiguous source)" });
  const file = row.loc ? openLoc(row.loc, attachmentDirs()) : null;
  if (!file) return apiJson(404, { ok: false, error: "media file missing" });
  const cache = "private, max-age=604800, immutable";
  if (variant === "thumb" || display) {
    const out = await convertedImage(paths.thumbs, id, variant === "thumb" ? "thumb" : "display", file.abs, file.name);
    if (out) return new Response(Bun.file(out), { headers: { "Content-Type": "image/jpeg", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
  }
  const mime = attachmentMime(file.name);
  const inline = mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("text/");
  return new Response(Bun.file(file.abs), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": cache,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "X-Content-Type-Options": "nosniff",
      ...(mime === "image/svg+xml" ? { "Content-Security-Policy": SVG_CSP } : {}),
    },
  });
}

export async function handleMedia(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (path === "/media") return listMedia(url, principal);
  const m = path.match(/^\/media\/([0-9a-f]{24})\/(raw|thumb)$/);
  if (!m) return null;
  return serveFile(m[1], m[2] as "raw" | "thumb", url.searchParams.get("display") === "1", principal);
}

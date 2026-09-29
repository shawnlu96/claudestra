/**
 * 图片与文件（媒体索引）端点：
 *   GET /api/v1/media?agent=&kind=image|file&q=&dir=in|out&cat=&since=&until=&before=|after=&limit=
 *   GET /api/v1/media?…&around=<媒体 id> | &name=<气泡里的文件名>[&session=&seq_from=&seq=]   —— 大图查看器取一窗
 *   GET /api/v1/media/:id/raw[?display=1]   GET /api/v1/media/:id/thumb
 * 口径与 /history、/history/search 相同：候选 agent = registry + 归档目录 + master，按 token scope 过滤结果；
 * 取文件按索引行的 agent 核 scope，绑定不可信 / 有歧义 / 跨 agent 认领的行只给 manage（lib/media-query.ts isRestricted）。
 * 库访问与刷新调度在 media-refresh.ts。
 */
import { attachmentMime } from "../../lib/attachment-lookup.js";
import { canManage } from "../../lib/devices.js";
import { findAnchor, isRestricted, mediaRow, queryAround, queryMedia, type MediaFilter, type Viewer } from "../../lib/media-query.js";
import { openLoc } from "../../lib/media-store.js";
import { convertedImage } from "../../lib/media-thumb.js";
import { agentInScope, type Principal } from "../../lib/principals.js";
import { isMasterName } from "../../lib/registry.js";
import { apiJson } from "../api-respond.js";
import { attachmentDirs } from "./attachments.js";
import { awaitRefresh, listAgents, mediaDb, mediaPaths, recoverIfCorrupt, refreshMedia, type AgentInfo } from "./media-refresh.js";

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";
/** 不用 immutable：行的可见性会变（新认领让它变成共享 / 受限），浏览器别把旧结果长期当真 */
const CACHE = "private, max-age=3600";

/**
 * 调用方 scope 内的 agent；指定了 agent 就只要它（不在 scope → null = 403）。
 * master 的写法按 registry.isMasterName（大小写、全角、多层 agent- 前缀、网页会话名 __master__），与其他 /api/v1 路由同一口径。
 */
async function scopedAgents(principal: Principal, want: string | null): Promise<AgentInfo[] | null> {
  const all = (await listAgents()).filter((a) => agentInScope(principal, a.name));
  if (!want) return all;
  const name = isMasterName(want) ? "master" : want;
  const hit = all.find((a) => a.name === name || a.name === `agent-${name}`);
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

function viewerOf(principal: Principal): Viewer {
  const dirs = attachmentDirs();
  return { manage: canManage(principal), exists: (loc) => !!openLoc(loc, dirs) };
}

async function listMedia(url: URL, principal: Principal): Promise<Response> {
  const p = url.searchParams;
  const agents = await scopedAgents(principal, p.get("agent"));
  if (!agents) return apiJson(403, { ok: false, error: "agent not in token scope" });
  const anchored = !!(p.get("around") || p.get("name"));
  // 气泡点图：强制重扫这个 agent 并等它扫完（刚发的图 10 秒节流内也得认得出来），其余请求按节流短等
  const job = refreshMedia(anchored && agents.length === 1 ? [agents[0].name] : []);
  const building = !(anchored ? await Promise.race([job.then(() => true), Bun.sleep(5_000).then(() => false)]) : await awaitRefresh(job));
  const db = mediaDb();
  const f = filterOf(url, agents.map((a) => a.name));
  const v = viewerOf(principal);
  const limit = Math.max(1, Math.min(200, Math.floor(num(p.get("limit")) ?? 60)));
  if (anchored) {
    const seqTo = num(p.get("seq"));
    const key = { id: p.get("around") || undefined, name: p.get("name") || undefined, sessionId: p.get("session") || undefined, seqFrom: num(p.get("seq_from")) ?? seqTo, seqTo };
    const anchor = findAnchor(db, f, key, v.manage);
    if (!anchor) return apiJson(404, { ok: false, error: "media not found", building });
    return apiJson(200, { ok: true, building, ...queryAround(db, f, anchor, Math.ceil(limit / 2), v) });
  }
  return apiJson(200, { ok: true, building, ...queryMedia(db, f, { before: p.get("before"), after: p.get("after"), limit }, v) });
}

async function serveFile(id: string, variant: "raw" | "thumb", display: boolean, principal: Principal): Promise<Response> {
  const row = mediaRow(mediaDb(), id);
  // 不在 scope、不存在、绑定不可信（非 manage）、文件不在一律回同一个 404（逐字节相同）：不让人按 id 探测文件在不在；
  // 可信但歧义 / 共享的回 403（列表里也标了 restricted）
  const notFound = () => apiJson(404, { ok: false, error: "media not found" });
  if (!row || !agentInScope(principal, row.agent)) return notFound();
  const manage = canManage(principal);
  if (!manage && row.trusted !== 1) return notFound();
  if (isRestricted(row, manage)) return apiJson(403, { ok: false, error: "media restricted (ambiguous source)" });
  const file = row.loc ? openLoc(row.loc, attachmentDirs()) : null;
  if (!file || !row.loc) return notFound();
  if (variant === "thumb" || display) {
    const out = await convertedImage(mediaPaths.thumbs, id, row.loc, variant === "thumb" ? "thumb" : "display", file.abs, file.name);
    if (out === "failed") return apiJson(422, { ok: false, error: "image cannot be converted" }); // 网格 / 查看器显示占位
    if (out === "busy") return new Response(JSON.stringify({ ok: false, error: "thumbnailer busy" }), { status: 503, headers: { "Retry-After": "2", "Content-Type": "application/json" } });
    if (out) return new Response(Bun.file(out), { headers: { "Content-Type": "image/jpeg", "Cache-Control": CACHE, "X-Content-Type-Options": "nosniff" } });
  }
  const mime = attachmentMime(file.name);
  const inline = mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("text/");
  return new Response(Bun.file(file.abs), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": CACHE,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "X-Content-Type-Options": "nosniff",
      ...(mime === "image/svg+xml" ? { "Content-Security-Policy": SVG_CSP } : {}),
    },
  });
}

export async function handleMedia(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const m = path === "/media" ? null : path.match(/^\/media\/([0-9a-f]{24})\/(raw|thumb)$/);
  if (path !== "/media" && !m) return null;
  try {
    return m ? await serveFile(m[1], m[2] as "raw" | "thumb", url.searchParams.get("display") === "1", principal) : await listMedia(url, principal);
  } catch (e) {
    // 库坏了：删库重建（下次请求自己重扫），这次回 503 让前端稍后再拉
    if (recoverIfCorrupt(e)) return apiJson(503, { ok: false, error: "media index rebuilding" });
    throw e;
  }
}

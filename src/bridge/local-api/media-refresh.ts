/**
 * 媒体索引的库访问与刷新调度（端点在 media.ts）。
 * - 刷新一律刷全部 agent，不跟调用方 scope 走：跨 agent 的认领判断（同一文件被几个 agent 认领、别人同窗发过同名出站）
 *   要看得到所有 agent 的行，只刷 guest 自己那几个 agent 时这些判断全部失效（T22 审查 P0-1 第 3 条）。出结果时再按 scope 过滤。
 * - 同一时刻只跑一轮，后来的请求等同一轮；每个 agent 10 秒内不重扫，锚点请求可以对单个 agent 强制重扫（刚发的图立刻能点开）。
 * - 库坏了（打不开 / 查询报损坏）就删掉重建，缩略图缓存一起清。
 * - bridge 拷贝出站附件也从这里走（copyOutboundToInbox），账记进同一个库。
 */
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { openMediaIndex, refreshMediaIndex, resetMediaIndex, type MediaSource } from "../../lib/media-index.js";
import { copyOutboundFiles } from "../../lib/media-outbound.js";
import { clearThumbs } from "../../lib/media-thumb.js";
import { ARCHIVE_ROOT, statePath } from "../../lib/paths.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { listAgentSessions } from "../../lib/session-history.js";
import { MASTER_DIR } from "../config.js";
import { latestSessionIdForCwd } from "../session-ids.js";
import { attachmentDirs } from "./attachments.js";

const REFRESH_EVERY_MS = 10_000;

export interface AgentInfo {
  name: string;
  cwd?: string;
  sessionId?: string;
  runtime?: string;
}

export const mediaPaths = { db: statePath("media-index.sqlite"), thumbs: statePath("media-thumbs") };
let agentsProvider: () => Promise<AgentInfo[]> = defaultAgents;
let sourcesProvider: (agents: AgentInfo[]) => Promise<MediaSource[]> = sourcesOf;
const lastRefresh = new Map<string, number>();
let inflight: Promise<void> | null = null;
/** 至少完整刷完过一轮：之前的请求值得多等一会儿（首建），之后只短等 */
let builtOnce = false;

/** 单测：库 / 缩略图目录指到临时路径，agent 清单与会话文件清单换成桩 */
export function setMediaForTest(
  o: { db?: string; thumbs?: string; agents?: () => Promise<AgentInfo[]>; sources?: (agents: AgentInfo[]) => Promise<MediaSource[]> } | undefined,
): void {
  mediaPaths.db = o?.db ?? statePath("media-index.sqlite");
  mediaPaths.thumbs = o?.thumbs ?? statePath("media-thumbs");
  agentsProvider = o?.agents ?? defaultAgents;
  sourcesProvider = o?.sources ?? sourcesOf;
  lastRefresh.clear();
  inflight = null;
  builtOnce = false;
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

async function sourcesOf(agents: AgentInfo[]): Promise<MediaSource[]> {
  const out: MediaSource[] = [];
  for (const a of agents) {
    const sessions = await listAgentSessions(a.name, { cwd: a.cwd, currentSessionId: a.sessionId, runtime: a.runtime });
    for (const s of sessions) out.push({ agent: a.name, sessionId: s.sessionId, path: s.path });
  }
  return out;
}

export const listAgents = (): Promise<AgentInfo[]> => agentsProvider();

export function mediaDb(): Database {
  return openMediaIndex(mediaPaths.db, () => clearThumbs(mediaPaths.thumbs));
}

/** 查询报库损坏：删库、清缩略图，下次请求重建；返回是不是这类错误 */
export function recoverIfCorrupt(e: unknown): boolean {
  if (!/malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String((e as Error)?.message ?? e))) return false;
  console.error(`[media] 索引库损坏，删掉重建: ${(e as Error).message}`);
  resetMediaIndex(mediaPaths.db);
  clearThumbs(mediaPaths.thumbs);
  lastRefresh.clear();
  builtOnce = false;
  return true;
}

/** 刷新到期的 agent（force 里的不管节流）；返回这一轮的 promise，调用方自己决定等多久 */
export function refreshMedia(force: string[] = []): Promise<void> {
  const run = async () => {
    const all = await agentsProvider();
    const now = Date.now();
    const due = all.filter((a) => force.includes(a.name) || now - (lastRefresh.get(a.name) ?? 0) >= REFRESH_EVERY_MS);
    if (!due.length) return;
    for (const a of due) lastRefresh.set(a.name, now);
    const complete = due.length === all.length;
    await refreshMediaIndex(mediaDb(), await sourcesProvider(due), attachmentDirs(), { now, complete });
    if (complete) builtOnce = true;
  };
  const next: Promise<void> = (inflight ?? Promise.resolve())
    .then(run)
    .catch((e) => {
      if (!recoverIfCorrupt(e)) console.error("[media] 索引刷新失败:", (e as Error).message);
    })
    .finally(() => {
      if (inflight === next) inflight = null;
    });
  inflight = next;
  return next;
}

/** 首建前多等（最多 3 秒，先把能出的出了），建好之后只短等（新消息尽快出现，但不拖慢翻页） */
export async function awaitRefresh(job: Promise<void>): Promise<boolean> {
  const ms = builtOnce ? 300 : 3_000;
  return Promise.race([job.then(() => true), Bun.sleep(ms).then(() => false)]);
}

/** bridge 投递 reply 附件时调：拷进 inbox 并记账（库打不开也照样拷，只是这几份没账） */
export async function copyOutboundToInbox(paths: string[], agent: string): Promise<{ name: string; attachment: string }[]> {
  let db: Database | null = null;
  try {
    db = mediaDb();
  } catch (e) {
    console.error("[media] 出站副本记账失败（索引库打不开）:", (e as Error).message);
  }
  return copyOutboundFiles(paths, agent, attachmentDirs().inboxDirs[0], db);
}

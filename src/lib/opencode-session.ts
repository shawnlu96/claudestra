/**
 * OpenCode 会话的只读来源（docs/runtimes/opencode-acp.md §6）。OpenCode 把会话存在 SQLite 里，而历史 API / 宿主回放都按「一行一条」
 * 读文件，所以这里把 `opencode export <id>` 的结果镜像成状态目录下的 JSONL（一行一条消息 `{info, parts}`），再逐行翻成 Claude Code 形状。
 * 只走 OpenCode 自己的 CLI（export / db 查询），从不打开它的库、不往它的目录写：库结构是它内部的，没承诺稳定。
 */
import { mkdirSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { opencodeBin, opencodeDirsEnv } from "./acp/opencode-bin.js";
import { statePath } from "./paths.js";
import { writeTextAtomicSync } from "./state-file.js";
import type { AnyRecord, DiscoveredSession } from "./runtimes/types.js";

type Env = Record<string, string | undefined>;

/** 子进程与库定位用的 env：沙箱里 HOME / XDG_* 指到沙箱根（opencodeDirsEnv），沙箱外原样 */
const withOpencodeDirs = (env: Env): Env => ({ ...env, ...opencodeDirsEnv(env) });

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
/** 只认这个形状：id 会进子进程 argv，别的形状（以 - 开头之类）一律不碰 */
export const isValidOpencodeSessionId = (id: string): boolean => SESSION_ID_RE.test(id);

const OPENCODE_MIRROR_DIR = statePath("opencode-sessions");
export const opencodeMirrorPath = (sessionId: string): string => join(OPENCODE_MIRROR_DIR, `${sessionId}.jsonl`);

const EXPORT_TIMEOUT_MS = 15_000;
const SCAN_TIMEOUT_MS = 20_000;
/** 同一个 id 两次导出至少隔这么久：历史面板轮询 + 宿主回放会连着要同一份，每次都起子进程（~2s）会把 bridge 卡住 */
const REFRESH_THROTTLE_MS = 2_000;
const lastAttempt = new Map<string, number>();

/** OpenCode 库文件（WAL 模式下新写入先落 -wal）最新的 mtime；都不在返回 0 */
function opencodeDbMtime(env: Env): number {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME || homedir(), ".local", "share");
  const db = join(dataHome, "opencode", "opencode.db");
  let max = 0;
  for (const p of [db, `${db}-wal`]) {
    try { max = Math.max(max, statSync(p).mtimeMs); } catch { /* 文件不在：-wal 在 checkpoint 后可以没有，按 0 算 */ }
  }
  return max;
}

function mirrorMtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; } // 镜像还没建：调用方据此去导出
}

/** export 的 stdout → 镜像正文（一行一条消息）；不是这个会话的导出返回 null */
function exportToJsonl(stdout: string, sessionId: string): string | null {
  let doc: AnyRecord;
  try { doc = JSON.parse(stdout); } catch { return null; } // 半截输出 / 报错文本：调用方记原因
  if (doc?.info?.id !== sessionId || !Array.isArray(doc.messages)) return null;
  return doc.messages.map((m: AnyRecord) => JSON.stringify({ info: m?.info ?? {}, parts: Array.isArray(m?.parts) ? m.parts : [] })).join("\n") + "\n";
}

export interface RefreshOpts {
  env?: Env;
  now?: () => number;
}

type ExportPlan = { path: string; have: number | null; bin?: string; env: Env; now: number };

/** 要不要导出：镜像比库新 / 节流内 / 没装 opencode 都不导（bin 为空）；要导就先记一次尝试 */
function planExport(sessionId: string, opts: RefreshOpts): ExportPlan {
  const env = withOpencodeDirs(opts.env ?? process.env);
  const now = (opts.now ?? Date.now)();
  const path = opencodeMirrorPath(sessionId);
  const have = mirrorMtime(path);
  const dbMtime = opencodeDbMtime(env);
  if (have !== null && dbMtime > 0 && have >= dbMtime) return { path, have, env, now };
  if (now - (lastAttempt.get(sessionId) ?? -Infinity) < REFRESH_THROTTLE_MS) return { path, have, env, now };
  lastAttempt.set(sessionId, now);
  const bin = opencodeBin(env) ?? undefined;
  if (bin) mkdirSync(OPENCODE_MIRROR_DIR, { recursive: true });
  return { path, have, bin, env, now };
}

/** cwd 放镜像目录（不是 git 仓库）：OpenCode 启动时会按 cwd 认项目，放在仓库里会给它的库添一条无关项目 */
const exportCmd = (bin: string, sessionId: string, env: Env) => ({ cmd: [bin, "export", sessionId], cwd: OPENCODE_MIRROR_DIR, env, timeout: EXPORT_TIMEOUT_MS });

/** 导出结果落镜像；失败记原因。返回能给调用方的路径（失败时有旧镜像给旧的：显示旧一点的历史好过没有） */
function finishExport(sessionId: string, p: ExportPlan, code: number | null, stdout: string, stderr: string): string | null {
  const body = code === 0 ? exportToJsonl(stdout, sessionId) : null;
  if (body === null) {
    console.error(`[opencode-session] 导出 ${sessionId} 失败（${code === 0 ? "输出不是这个会话的导出 JSON" : `exit ${code ?? "?"}`}）：${stderr.trim().slice(-300)}`);
    return p.have === null ? null : p.path;
  }
  writeTextAtomicSync(p.path, body, { mode: 0o600 });
  // 库 mtime 要在导出之后量：export 自己开关库会 checkpoint、改 mtime，按导出前的量就永远判旧、每次都重导（实测）。
  // ponytail: 导出那 ~2s 里别的会话的最后一次写入会被当成已导出，要等库下次变动才补上；要严格就改比 session.time_updated
  const after = opencodeDbMtime(p.env);
  if (after > 0) utimesSync(p.path, new Date(p.now), new Date(Math.ceil(after))); // 库 mtime 带亚毫秒，Date 只到毫秒：向上取整，否则永远差一点判旧
  return p.path;
}

/**
 * 同步导出一次并写镜像（~2s，最坏卡调用方 EXPORT_TIMEOUT_MS）；镜像比库新就不导出。只给单测和必须拿到最新的地方用，
 * 会话来源走 opencodeMirrorPathNow（bridge 的 agents 列表、各 watcher 会周期性要路径，不能卡事件循环）。tests/opencode-session.test.ts
 */
export function refreshOpencodeMirror(sessionId: string, opts: RefreshOpts = {}): string | null {
  if (!isValidOpencodeSessionId(sessionId)) return null;
  const p = planExport(sessionId, opts);
  if (!p.bin) return p.have === null ? null : p.path;
  const r = Bun.spawnSync({ ...exportCmd(p.bin, sessionId, p.env), stdout: "pipe", stderr: "pipe" });
  return finishExport(sessionId, p, r.exitCode, r.stdout.toString(), r.stderr.toString());
}

const inFlight = new Map<string, Promise<string | null>>();

/** 后台导出（同一 id 同时只跑一个）；单测可 await 它 */
export function refreshOpencodeMirrorAsync(sessionId: string, opts: RefreshOpts = {}): Promise<string | null> {
  const running = inFlight.get(sessionId);
  if (running) return running;
  if (!isValidOpencodeSessionId(sessionId)) return Promise.resolve(null);
  const p = planExport(sessionId, opts);
  if (!p.bin) return Promise.resolve(p.have === null ? null : p.path);
  const job = (async () => {
    const proc = Bun.spawn({ ...exportCmd(p.bin!, sessionId, p.env), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return finishExport(sessionId, p, code, out, err);
  })().catch((e) => (console.error(`[opencode-session] 导出 ${sessionId} 起不来：${String(e)}`), p.have === null ? null : p.path))
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, job);
  return job;
}

/** 会话来源用：不等导出——有镜像立刻给（可能旧几秒），过期就后台刷；第一次还没有镜像时返回 null，刷完下一次就有 */
export function opencodeMirrorPathNow(sessionId: string, opts: RefreshOpts = {}): string | null {
  if (!isValidOpencodeSessionId(sessionId)) return null;
  void refreshOpencodeMirrorAsync(sessionId, opts);
  return mirrorMtime(opencodeMirrorPath(sessionId)) === null ? null : opencodeMirrorPath(sessionId);
}

export function opencodeSessionIdFromPath(path: string): string | null {
  const name = basename(path);
  if (!name.endsWith(".jsonl")) return null;
  const id = name.slice(0, -".jsonl".length);
  return isValidOpencodeSessionId(id) ? id : null;
}

export const isOpencodeMirrorPath = (path: string): boolean =>
  path.startsWith(`${OPENCODE_MIRROR_DIR}/`) && opencodeSessionIdFromPath(path) !== null;

/** 镜像行的头特征（归档副本没有路径特征时用） */
export const isOpencodeMirrorRecord = (rec: AnyRecord | null | undefined): boolean =>
  typeof rec?.info?.sessionID === "string" && rec.info.sessionID.startsWith("ses_") && Array.isArray(rec.parts);

// ── 翻译 ─────────────────────────────────────────────────────────────

/** 内置工具名 → Claude Code 同名（工具卡的摘要按 CC 的名字和 file_path / old_string 这些键取） */
const BUILTIN_TOOLS: Record<string, string> = {
  bash: "Bash", read: "Read", edit: "Edit", write: "Write", glob: "Glob", grep: "Grep",
  webfetch: "WebFetch", todowrite: "TodoWrite", task: "Task",
};
const INPUT_KEYS: Record<string, string> = { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" };

/** OpenCode 把 MCP 工具叫 `<server>_<tool>`；我们自己的 server 改成 mcp__<server>__<tool>，reply 的识别（isReplyTool）才认得 */
function toolUseOf(tool: string, input: AnyRecord, mcpServers: readonly string[]): { name: string; input: AnyRecord } {
  const cc = BUILTIN_TOOLS[tool];
  if (cc) return { name: cc, input: Object.fromEntries(Object.entries(input).map(([k, v]) => [INPUT_KEYS[k] ?? k, v])) };
  const server = mcpServers.find((s) => tool.startsWith(`${s}_`) && tool.length > s.length + 1);
  return server ? { name: `mcp__${server}__${tool.slice(server.length + 1)}`, input } : { name: tool, input };
}

/** tool 部件 → tool_use（+ 终态时同一条里的 tool_result，历史解析认这种「结果和调用同一条」，见 session-history-parse） */
function toolBlocks(part: AnyRecord, mcpServers: readonly string[]): AnyRecord[] {
  const st: AnyRecord = part.state && typeof part.state === "object" ? part.state : {};
  const id = String(part.callID ?? part.id ?? "");
  const input = st.input && typeof st.input === "object" ? st.input : {};
  const out: AnyRecord[] = [{ type: "tool_use", id, ...toolUseOf(String(part.tool ?? "tool"), input, mcpServers) }];
  if (st.status === "completed") out.push({ type: "tool_result", tool_use_id: id, content: typeof st.output === "string" ? st.output : "" });
  else if (st.status === "error") out.push({ type: "tool_result", tool_use_id: id, content: String(st.error ?? ""), is_error: true });
  return out;
}

const textOf = (parts: AnyRecord[]): string =>
  parts.filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n");

const defaultMcpServers = (): string[] => [process.env.MCP_NAME || "claudestra"];

/**
 * 镜像的一行（一条 OpenCode 消息）→ 一条 Claude Code 形状记录；不是对话内容返回 null。
 * - user：text 部件拼成正文；`<channel …>` 包装的（ACP 宿主投进来的）标 isMeta，同 Codex / Pi；只有 compaction 部件的那条是压缩请求，跳过；
 * - assistant：text / tool 部件按原顺序成块（reasoning、step-* 不要）；summary=true 的是压缩摘要 → compact_boundary（边界落在压缩完成处，同 CC）。
 */
export function opencodeLineToClaudeShape(line: string, mcpServers: readonly string[] = defaultMcpServers()): AnyRecord | null {
  let rec: AnyRecord;
  try { rec = JSON.parse(line); } catch { return null; } // 不是 JSON 的行（截断）不是对话
  const info: AnyRecord = rec?.info && typeof rec.info === "object" ? rec.info : {};
  const parts: AnyRecord[] = Array.isArray(rec?.parts) ? rec.parts : [];
  const created = info.time?.created;
  const timestamp = typeof created === "number" ? new Date(created).toISOString() : undefined;

  if (info.role === "user") {
    const text = textOf(parts);
    if (!text) return null;
    return { type: "user", ...(/^\s*<channel\s/.test(text) ? { isMeta: true } : {}), timestamp, message: { content: text } };
  }
  if (info.role !== "assistant") return null;
  if (info.summary === true) return { type: "system", subtype: "compact_boundary", timestamp, compactSummary: textOf(parts) || undefined };
  const content = parts.flatMap((p) =>
    p?.type === "text" && typeof p.text === "string" && p.text && !p.synthetic ? [{ type: "text", text: p.text }]
      : p?.type === "tool" ? toolBlocks(p, mcpServers) : []);
  if (!content.length) return null;
  return { type: "assistant", timestamp, message: { ...(info.modelID ? { model: String(info.modelID) } : {}), content } };
}

// ── 扫描 ─────────────────────────────────────────────────────────────

/**
 * `opencode session list` 只列当前目录所属项目的会话（实测：从 / 跑看不到 git 仓库里的会话），全机扫描只能走 `opencode db` 的只读查询——
 * 仍是 OpenCode 自己的连接，不和它抢写锁。最后一条用户正文按 part 表取，取不到用标题。
 */
const SCAN_SQL = `SELECT s.id, s.directory, s.title, s.time_updated, s.parent_id,
 (SELECT json_extract(p.data, '$.text') FROM part p JOIN message m ON m.id = p.message_id
   WHERE p.session_id = s.id AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
   ORDER BY p.time_created DESC LIMIT 1) AS last_user
 FROM session s WHERE s.time_archived IS NULL ORDER BY s.time_updated DESC`;

export function opencodeRowToSession(row: AnyRecord): DiscoveredSession | null {
  const sessionId = String(row?.id ?? "");
  const cwd = typeof row?.directory === "string" ? row.directory : "";
  if (!isValidOpencodeSessionId(sessionId) || !cwd) return null;
  const last = typeof row.last_user === "string" && row.last_user.trim() ? row.last_user : String(row.title ?? "");
  return {
    sessionId,
    cwd,
    slug: cwd.split("/").filter(Boolean).pop() || "",
    modifiedAt: new Date(Number(row.time_updated) || 0),
    lastUserMessage: last.replace(/\n/g, " ").slice(0, 80),
    runtime: "opencode",
    ...(typeof row.parent_id === "string" && row.parent_id ? { sub: { parentId: row.parent_id, kind: "subagent" } } : {}),
  };
}

export async function scanOpencodeSessions(search?: string, baseEnv: Env = process.env): Promise<DiscoveredSession[]> {
  const env = withOpencodeDirs(baseEnv);
  const bin = opencodeBin(env);
  if (!bin) return [];
  mkdirSync(OPENCODE_MIRROR_DIR, { recursive: true });
  const proc = Bun.spawn({ cmd: [bin, "db", SCAN_SQL, "--format", "json"], cwd: OPENCODE_MIRROR_DIR, env, stdout: "pipe", stderr: "pipe", timeout: SCAN_TIMEOUT_MS });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let rows: unknown;
  try { rows = code === 0 ? JSON.parse(stdout) : null; } catch { rows = null; } // 下面统一记原因
  if (!Array.isArray(rows)) {
    console.error(`[opencode-session] 扫描会话失败（exit ${code}）：${stderr.trim().slice(-300)}`);
    return [];
  }
  const q = search?.toLowerCase();
  return rows
    .map((r) => opencodeRowToSession(r as AnyRecord))
    .filter((s): s is DiscoveredSession => s !== null && (!q || `${s.cwd} ${s.sessionId} ${s.lastUserMessage}`.toLowerCase().includes(q)));
}

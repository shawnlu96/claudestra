/**
 * token 账（T83）的导入：Claude Code 会话文件 → usage.sqlite。按文件记读到的字节偏移，只读新增的整行，重复跑幂等。
 * 覆盖面：在册 agent 的当前会话、archive/<agent>/ 的退役快照、~/.claude/projects 下其余全部会话（认不出主人的记 unowned）；
 * 子 agent（<sid>/subagents/…）记到父会话的主人，标 sidechain。Codex / Pi 的记录不在这里（Codex 归 T2）。
 * 只在 manager 子进程里跑（首轮要读几个 GB），bridge 只负责每天拉起一次（bridge/archive-sweeper.ts）。
 */
import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { basename, join, relative, sep } from "path";
import { projectJsonlPath } from "./jsonl-cost.js";
import { ARCHIVE_ROOT } from "./paths.js";
import { agentRuntime, readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { claudeProjectsRoot } from "./runtimes/claude-code.js";
import { runtimeForSessionPath } from "./session-source.js";
import { callOf, inboundOf, triggerSummary } from "./usage-classify.js";
import { pruneUsage, retentionCutoff, UNOWNED, usageWriter, type FileState } from "./usage-store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface IngestOptions {
  projectsRoot?: string;
  archiveRoot?: string;
  registry?: Pick<RegistryAgent, "name" | "sessionId" | "cwd" | "runtime">[];
  /** mtime 早于它的文件不读；缺省 = 保留期下界（更早没写过的文件里不可能有保留期内的记录） */
  sinceMs?: number;
  now?: number;
  /** 单测调小，走跨块拼行 */
  chunkBytes?: number;
}

export interface IngestResult {
  files: number;
  read: number;
  bytes: number;
  calls: number;
  pruned: number;
  ms: number;
}

interface SessionFile {
  path: string;
  sessionId: string;
  sidechain: boolean;
}

/** 路径 → 它属于哪个会话：根下第一个 UUID 形状的段；是目录（后面还有段）= 子 agent 文件 */
function sessionOfPath(path: string, root: string): SessionFile | null {
  const parts = relative(root, path).split(sep);
  for (let i = 0; i < parts.length; i++) {
    const id = i === parts.length - 1 ? parts[i].replace(/\.jsonl$/, "") : parts[i];
    if (UUID_RE.test(id)) return { path, sessionId: id, sidechain: i < parts.length - 1 };
  }
  return null;
}

function walkJsonl(dir: string, out: string[], depth = 0): void {
  if (depth > 16) return; // 防软链环
  let ents: import("fs").Dirent[];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; } // 根不存在 / 扫描中被删：这一趟没有它
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** sessionId → agent：在册 agent 的当前会话优先，其次归档目录名（archive/<agent>/<sid>…；master 的历代会话也在这里） */
function sessionOwners(registry: NonNullable<IngestOptions["registry"]>, archiveRoot: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const a of registry) if (a.sessionId && agentRuntime(a) === "claude-code") owners.set(a.sessionId, a.name);
  let agents: string[] = [];
  try { agents = readdirSync(archiveRoot); } catch { return owners; } // 还没有归档目录：只有在册的
  for (const agent of agents) {
    if (agent === "archived" || agent.startsWith(".")) continue; // archived/ 是手动归档区，按会话 id 认
    let names: string[] = [];
    try { names = readdirSync(join(archiveRoot, agent)); } catch { continue; } // 不是目录
    for (const n of names) {
      const id = n.replace(/\.jsonl$/, "");
      if (UUID_RE.test(id) && !owners.has(id)) owners.set(id, agent);
    }
  }
  return owners;
}

/** 要读的文件，按优先级：在册当前会话 → 归档 → 其余。跨文件重复的调用归第一个读到它的文件，所以顺序决定归属 */
function listFiles(o: Required<Pick<IngestOptions, "projectsRoot" | "archiveRoot" | "registry">>): SessionFile[] {
  const seen = new Set<string>();
  const out: SessionFile[] = [];
  const add = (f: SessionFile | null) => {
    if (f && !seen.has(f.path)) {
      seen.add(f.path);
      out.push(f);
    }
  };
  for (const a of o.registry) {
    if (!a.sessionId || !a.cwd || agentRuntime(a) !== "claude-code") continue;
    const p = projectJsonlPath(a.cwd, a.sessionId);
    add({ path: p, sessionId: a.sessionId, sidechain: false });
  }
  for (const [root] of [[o.archiveRoot], [o.projectsRoot]]) {
    const files: string[] = [];
    walkJsonl(root, files);
    for (const p of files.sort()) add(sessionOfPath(p, root));
  }
  return out;
}

/** 调用只收保留期内的：更早的明细反正要清，收进来还会在清理后被副本重复计入 daily */
function ingestFile(w: ReturnType<typeof usageWriter>, db: Database, f: SessionFile, agent: string, cutoff: number, chunkBytes: number) {
  let fd: number;
  try { fd = openSync(f.path, "r"); } catch { return { bytes: 0, calls: 0 }; } // 刚被挪走 / 删掉：下一趟再说
  let bytes = 0;
  let calls = 0;
  try {
    const size = fstatSync(fd).size;
    const prev = w.file(f.path);
    // 比上次读到的还短 = 文件被重写了：从头再读（调用按键去重，不会重复计）
    const st: FileState = prev && prev.offset <= size ? { ...prev }
      : { path: f.path, offset: 0, size, session_id: f.sessionId, agent, sidechain: f.sidechain ? 1 : 0, turn_id: null, turn_start: null, turn_kind: null, turn_trigger: null };
    let ensured: string | null = null;
    let want = chunkBytes;
    while (st.offset < size) {
      const n = Math.min(want, size - st.offset);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, st.offset);
      const end = buf.lastIndexOf(10);
      if (end < 0) {
        if (st.offset + n >= size) break; // 文件尾的半行：写的人还没写完，下一趟再读
        want *= 2; // 一行比一块还长
        continue;
      }
      want = chunkBytes;
      db.transaction(() => {
        for (const line of buf.toString("utf8", 0, end).split("\n")) {
          const r = handleLine(line, st, f, cutoff);
          if (!r) continue;
          if (ensured !== st.turn_id) {
            w.turn({
              turnId: st.turn_id!, agent: st.agent, sessionId: f.sessionId, sidechain: f.sidechain,
              startedAt: st.turn_start!, kind: st.turn_kind ?? "continued", trigger: st.turn_trigger ?? "",
            });
            ensured = st.turn_id;
          }
          w.call(r, st.turn_id!);
          calls++;
        }
        st.offset += end + 1;
        st.size = size;
        w.saveFile(st);
      })();
      bytes += end + 1;
    }
    if (!prev) w.saveFile(st);
  } finally {
    closeSync(fd);
  }
  return { bytes, calls };
}

/** 一行：外来输入就切到新一轮（改 st），保留期内的调用返回给调用方入库。只解析可能相关的行（CC 写的是紧凑 JSON） */
function handleLine(line: string, st: FileState, f: SessionFile, cutoff: number) {
  const isCall = line.includes('"type":"assistant"') && line.includes('"usage"');
  const maybeInbound = (line.includes('"type":"user"') && !line.includes('"type":"tool_result"')) || line.includes('"queued_command"');
  if (!isCall && !maybeInbound) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; } // 坏行（写到一半被截断的老文件）：跳过这一行，不影响其它行
  if (!isCall) {
    const i = inboundOf(rec);
    if (!i) return null;
    const turnId = i.messageId ? `msg:${i.messageId}` : typeof rec.uuid === "string" ? rec.uuid : `${f.sessionId}:${rec.timestamp}`;
    if (turnId === st.turn_id) return null; // 同一条 channel 消息既进了队列附件又落了 user 记录
    st.turn_id = turnId;
    st.turn_start = Date.parse(rec.timestamp) || st.turn_start || 0;
    st.turn_kind = f.sidechain && i.kind === "human" ? "subagent" : i.kind;
    st.turn_trigger = triggerSummary(i);
    return null;
  }
  const c = callOf(rec);
  if (!c || c.ts < cutoff) return null;
  if (!st.turn_id) {
    // 文件从一轮中间开始（fork / 续写的副本）：这一段单独算一轮
    st.turn_id = `head:${f.sessionId}${f.sidechain ? `/${basename(f.path, ".jsonl")}` : ""}`;
    st.turn_start = c.ts;
    st.turn_kind = "continued";
    st.turn_trigger = "";
  }
  return c;
}

/** 之前记成 unowned 的会话后来认出了主人（归档快照是 kill 时才拷的）：轮和文件都改过去 */
function claimOwners(db: Database, w: ReturnType<typeof usageWriter>, owners: Map<string, string>): void {
  const rows = db.prepare(`SELECT DISTINCT session_id FROM files WHERE agent = '${UNOWNED}'`).all() as { session_id: string }[];
  const setFiles = db.prepare(`UPDATE files SET agent = ? WHERE session_id = ? AND agent = '${UNOWNED}'`);
  db.transaction(() => {
    for (const { session_id: sid } of rows) {
      const agent = owners.get(sid);
      if (!agent) continue;
      w.claimSession(sid, agent);
      setFiles.run(agent, sid);
    }
  })();
}

/** 导入一趟 + 清理超期明细 */
export function ingestUsage(db: Database, opts: IngestOptions = {}): IngestResult {
  const t0 = performance.now();
  const now = opts.now ?? Date.now();
  const cutoff = retentionCutoff(now);
  const o = {
    projectsRoot: opts.projectsRoot ?? claudeProjectsRoot(),
    archiveRoot: opts.archiveRoot ?? ARCHIVE_ROOT,
    registry: opts.registry ?? readRegistryAgentsSync(),
  };
  const owners = sessionOwners(o.registry, o.archiveRoot);
  const since = opts.sinceMs ?? cutoff;
  const w = usageWriter(db);
  const res: IngestResult = { files: 0, read: 0, bytes: 0, calls: 0, pruned: 0, ms: 0 };
  for (const f of listFiles(o)) {
    let mtime = 0;
    try { mtime = statSync(f.path).mtimeMs; } catch { continue; } // 在册会话还没生成文件 / 已被清理
    res.files++;
    if (mtime < since || runtimeForSessionPath(f.path) !== undefined) continue;
    const r = ingestFile(w, db, f, owners.get(f.sessionId) ?? UNOWNED, cutoff, opts.chunkBytes ?? CHUNK_BYTES);
    if (r.bytes) res.read++;
    res.bytes += r.bytes;
    res.calls += r.calls;
  }
  claimOwners(db, w, owners);
  res.pruned = pruneUsage(db, cutoff);
  res.ms = Math.round(performance.now() - t0);
  return res;
}

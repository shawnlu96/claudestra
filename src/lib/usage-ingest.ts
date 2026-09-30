/**
 * token 账（T83 / T92）的导入：Claude Code 会话文件与 Codex rollout → usage.sqlite。按文件记读到的字节偏移，只读新增的整行，重复跑幂等。
 * 覆盖面：在册 agent 的当前会话、archive/<agent>/ 的退役快照、~/.claude/projects 与 Codex sessions 下其余全部会话（认不出主人的记 unowned）；
 * 子 agent（<sid>/subagents/…、Codex 子线程）记到父会话的主人，标 sidechain。Codex 行的解析在 usage-codex.ts；Pi 的记录不收。
 * 只在 manager 子进程里跑（首轮要读几个 GB）：bridge 每 10 分钟拉起一趟增量、每天一趟带清理（bridge/archive-sweeper.ts），
 * 查询命令查之前也导一趟；几路之间靠 ingestLocked 的文件锁串行。
 */
import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { basename, join, relative, sep } from "path";
import { acquireLock } from "./file-lock.js";
import { projectJsonlPath } from "./jsonl-cost.js";
import { ARCHIVE_ROOT } from "./paths.js";
import { agentRuntime, readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { claudeProjectsRoot } from "./runtimes/claude-code.js";
import { codexRolloutRootOrSkip } from "./codex-home.js";
import { CODEX, codexThreadOfFile, handleCodexLine, type CodexLineCtx } from "./usage-codex.js";
import { runtimeForSessionPath } from "./session-source.js";
import { callOf, inboundIdentity, inboundOf, triggerSummary } from "./usage-classify.js";
import { pruneUsage, rebuildDirtyDays, retentionCutoff, UNOWNED, usageWriter, type FileState } from "./usage-store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface IngestOptions {
  projectsRoot?: string;
  archiveRoot?: string;
  /** Codex rollout 根；缺省 = CODEX_HOME / ~/.codex 的 sessions（沙箱配错时跳过）；null = 不读 Codex */
  codexRoot?: string | null;
  registry?: Pick<RegistryAgent, "name" | "sessionId" | "cwd" | "runtime">[];
  /** mtime 早于它的文件不读；缺省 = 保留期下界（更早没写过的文件里不可能有保留期内的记录） */
  sinceMs?: number;
  now?: number;
  /** 单测调小，走跨块拼行 */
  chunkBytes?: number;
  /** 顺带清掉保留期之前的明细；只有每日那趟开（清理是删数据，10 分钟一趟的增量不做） */
  prune?: boolean;
  /** 每读一块、认领 / 清理之前各调一次；返回 false（锁已失）就停在这里，没做完的下一趟接着做 */
  keepAlive?: () => boolean;
}

export interface IngestResult {
  files: number;
  read: number;
  bytes: number;
  calls: number;
  pruned: number;
  ms: number;
  /** 导到一半失了锁：停在这里，没读的、清理和 daily 重算都留给下一趟 */
  aborted?: boolean;
}

interface SessionFile {
  path: string;
  sessionId: string;
  sidechain: boolean;
  /** 已知是 Codex rollout；归档副本不知道，首次读时按首行嗅探 */
  runtime?: typeof CODEX;
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
  // Codex agent（tmux 与 ACP 两种接法）的 sessionId 就是 Codex 的 thread id；Pi 的记录不收
  for (const a of registry) if (a.sessionId && agentRuntime(a) !== "pi") owners.set(a.sessionId, a.name);
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
function listFiles(o: Required<Pick<IngestOptions, "projectsRoot" | "archiveRoot" | "registry" | "codexRoot">>): SessionFile[] {
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
  const rollouts: string[] = [];
  if (o.codexRoot) walkJsonl(o.codexRoot, rollouts);
  for (const p of rollouts.sort()) {
    const thread = codexThreadOfFile(basename(p));
    if (thread) add({ path: p, sessionId: thread, sidechain: false, runtime: CODEX });
  }
  return out;
}

/** 归档副本是不是 Codex rollout：首行是 session_meta（type 键在行首几十字节内，整行可能几十 KB，不用读完） */
function sniffCodex(fd: number): boolean {
  const b = Buffer.alloc(512);
  const got = readSync(fd, b, 0, 512, 0);
  return b.toString("utf8", 0, got).split("\n")[0].includes('"type":"session_meta"');
}

const FP_BYTES = 4096;

/** 文件身份：dev:ino + 已读部分（前 offset 字节）开头和结尾各 4KB 的哈希。换了文件、截断后重写都对不上 */
function fingerprint(fd: number, offset: number): string {
  const { dev, ino } = fstatSync(fd);
  const part = (at: number, n: number) => {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, at);
    return Bun.hash(b).toString(36);
  };
  const n = Math.min(FP_BYTES, offset);
  return `${dev}:${ino}:${part(0, n)}:${part(offset - n, n)}`;
}

/**
 * 调用只收保留期内的：更早的明细反正要清，收进来还会在清理后被副本重复计入 daily。
 * 上次的偏移只在同一个文件、已读部分没变时沿用；变短、换了 inode、已读部分被改写都从头重读（调用按主键去重，不会翻倍）。
 */
function ingestFile(w: ReturnType<typeof usageWriter>, db: Database, f: SessionFile, agent: string, ctx: CodexLineCtx, chunkBytes: number, alive: () => boolean) {
  let fd: number;
  try { fd = openSync(f.path, "r"); } catch { return { bytes: 0, calls: 0, aborted: false }; } // 刚被挪走 / 删掉：下一趟再说
  let bytes = 0;
  let calls = 0;
  let aborted = false;
  try {
    const size = fstatSync(fd).size;
    const prev = w.file(f.path);
    const same = prev && prev.offset <= size && (!prev.fp || prev.fp === fingerprint(fd, prev.offset));
    const st: FileState = same ? { ...prev } : {
      path: f.path, offset: 0, size, session_id: f.sessionId, agent, sidechain: f.sidechain ? 1 : 0,
      turn_id: null, turn_start: null, turn_kind: null, turn_trigger: null, fp: null, turn_input: null,
      runtime: f.runtime ?? (sniffCodex(fd) ? CODEX : null), model: null, parent: null,
    };
    let ensured: string | null = null;
    let want = chunkBytes;
    while (st.offset < size) {
      if (!alive()) {
        aborted = true;
        break;
      }
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
          const r = st.runtime === CODEX ? handleCodexLine(line, st, ctx) : handleLine(line, st, f, ctx.cutoff);
          if (!r) continue;
          if (ensured !== st.turn_id) {
            w.turn({
              turnId: st.turn_id!, agent: st.agent, sessionId: st.session_id, sidechain: st.sidechain === 1,
              startedAt: st.turn_start!, kind: st.turn_kind ?? "continued", trigger: st.turn_trigger ?? "", runtime: st.runtime ?? "claude-code",
            });
            ensured = st.turn_id;
          }
          w.call(r, st.turn_id!);
          calls++;
        }
        st.offset += end + 1;
        st.size = size;
        st.fp = fingerprint(fd, st.offset);
        w.saveFile(st);
      })();
      bytes += end + 1;
    }
    // 新文件、换过的文件、v1 库迁移来还没有指纹的文件：这趟没读到新行也把指纹记上
    if (!prev || !same || !st.fp) w.saveFile({ ...st, fp: st.fp ?? fingerprint(fd, st.offset) });
  } finally {
    closeSync(fd);
  }
  return { bytes, calls, aborted };
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
    // 同一条 channel 消息既进了队列附件又落了 user 记录：按 message_id + 正文认，同一张卡片上的不同选择正文不同，照样开新轮
    const input = inboundIdentity(i) ?? null;
    if (input && input === st.turn_input) return null;
    st.turn_input = input;
    // 轮 id = 条目自己的 uuid（fork 副本抄过去的同一条记录仍是同一轮）；channel 消息再带上输入身份，uuid 撞了也不会并轮
    const own = typeof rec.uuid === "string" && rec.uuid ? rec.uuid : `${f.sessionId}:${rec.timestamp}`;
    st.turn_id = input ? `${own}/${input}` : own;
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
    st.turn_input = null;
    st.turn_start = c.ts;
    st.turn_kind = "continued";
    st.turn_trigger = "";
  }
  return c;
}

/**
 * 之前记成 unowned 的会话后来认出了主人（归档快照是 kill 时才拷的；Codex 子线程的父线程后读到）：轮和文件都改过去。
 * 子线程按父线程找主人，父线程本身也可能是后来才认出的，所以放在每趟最后统一认。
 */
function claimOwners(db: Database, w: ReturnType<typeof usageWriter>, ctx: CodexLineCtx): void {
  const rows = db.prepare(`SELECT DISTINCT session_id, parent FROM files WHERE agent = '${UNOWNED}'`).all() as { session_id: string; parent: string | null }[];
  const setFiles = db.prepare(`UPDATE files SET agent = ? WHERE session_id = ? AND agent = '${UNOWNED}'`);
  db.transaction(() => {
    for (const { session_id: sid, parent } of rows) {
      const agent = ctx.ownerOf(sid, parent);
      if (agent === UNOWNED) continue;
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
    codexRoot: opts.codexRoot === undefined ? codexRolloutRootOrSkip("token 账导入 Codex") : opts.codexRoot,
  };
  const owners = sessionOwners(o.registry, o.archiveRoot);
  const since = opts.sinceMs ?? cutoff;
  const w = usageWriter(db);
  const ctx: CodexLineCtx = {
    cutoff, tool: w.tool,
    ownerOf: (thread, parent) => owners.get(thread) ?? (parent ? owners.get(parent) ?? w.knownOwner(parent) : null) ?? UNOWNED,
  };
  const res: IngestResult = { files: 0, read: 0, bytes: 0, calls: 0, pruned: 0, ms: 0 };
  // 每块、以及认领 / 清理 / 重算之前都核对一次锁（顺带续租）：导入是同步的，锁的定时续租跑不起来
  const alive = () => !opts.keepAlive || opts.keepAlive();
  const done = (aborted: boolean) => ({ ...res, ms: Math.round(performance.now() - t0), ...(aborted ? { aborted } : {}) });
  for (const f of listFiles(o)) {
    let mtime = 0;
    try { mtime = statSync(f.path).mtimeMs; } catch { continue; } // 在册会话还没生成文件 / 已被清理
    res.files++;
    const rt = runtimeForSessionPath(f.path);
    if (mtime < since || (rt !== undefined && rt !== CODEX)) continue; // Pi 不收
    const r = ingestFile(w, db, f, owners.get(f.sessionId) ?? UNOWNED, ctx, opts.chunkBytes ?? CHUNK_BYTES, alive);
    if (r.bytes) res.read++;
    res.bytes += r.bytes;
    res.calls += r.calls;
    if (r.aborted) return done(true);
  }
  if (!alive()) return done(true);
  claimOwners(db, w, ctx);
  if (!alive()) return done(true);
  if (opts.prune) res.pruned = pruneUsage(db, cutoff);
  else rebuildDirtyDays(db, cutoff);
  res.ms = Math.round(performance.now() - t0);
  return res;
}

/**
 * 拿到导入锁才导（锁是库文件旁的目录，lib/file-lock.ts）；等 waitMs 还拿不到 = 别的进程正在导，返回 null，调用方直接查现有数据。
 * 并发导入本身不会重复计数（主键去重），锁防的是两个进程把同一批 GB 级文件各读一遍。
 * 导入是同步的、锁的定时续租跑不起来，所以每读一块、认领 / 清理之前都手动续一次（held()）；失租就停，没做完的下一趟接着做。
 */
export async function ingestLocked(db: Database, lockPath: string, opts: IngestOptions = {}, waitMs = 0): Promise<IngestResult | null> {
  const lock = await acquireLock(lockPath, waitMs);
  if (!lock) return null;
  try {
    return ingestUsage(db, { ...opts, keepAlive: lock.held });
  } finally {
    lock.release();
  }
}

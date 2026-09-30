/**
 * 未纳管会话的归档与恢复：手动（web 列表左滑 / 抽屉「归档」「恢复」）与 Codex 子线程的每日自动归档共用一份写法。
 * 单测 tests/unmanaged-archive.test.ts。
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePath } from "./paths.js";
import { USER_ARCHIVE_ROOT } from "./session-archive.js";
import { isValidSessionId } from "./session-history.js";
import { listCodexSessionFiles, readCodexMetaPayload } from "./codex-session.js";
import { codexRolloutRoot } from "./codex-home.js";
import { codexSubOf, isCodexOneShot, isCodexSubThread } from "./codex-subthread.js";
import { readJsonState, writeJsonAtomic } from "./state-file.js";

export interface UnmanagedArchiveMeta {
  sessionId: string;
  runtime?: string | null;
  cwd?: string | null;
  /** 自动归档写明来由（手动归档不带），网页日后可以把两类分开显示 */
  reason?: string;
}

/**
 * 快照进 archive/archived/<sid>/，旁边写 .meta.json（恢复要知道原路径：cwd 编码不可逆），再删原文件。
 * 用复制不用 rename：副本的 mtime 是归档时刻，归档区按 mtime 算保留期（archive-sweeper pruneArchives）——
 * rename 保留原 mtime，几个月前的子线程一挪进来就会被当成超期清掉。
 * sessionId 会拼进目录名，而 Codex 的 id 来自文件内容：先过会话 id 白名单，建好目录再核对真实路径仍在归档根下一层
 * （防 `../` 和预先放好的软链把副本写到归档区外面）。
 */
export async function archiveUnmanagedFile(file: string, meta: UnmanagedArchiveMeta, root: string = USER_ARCHIVE_ROOT): Promise<string> {
  if (!isValidSessionId(meta.sessionId)) throw new Error(`会话 id 不合法，拒绝归档: ${JSON.stringify(meta.sessionId).slice(0, 80)}`);
  const dest = join(root, meta.sessionId);
  await mkdir(dest, { recursive: true });
  const [realRoot, realDest] = await Promise.all([realpath(root), realpath(dest)]);
  if (dirname(realDest) !== realRoot) throw new Error(`归档目录不在归档根下，拒绝写入: ${realDest}`);
  await copyFile(file, join(dest, file.split("/").pop()!));
  const record = {
    kind: "unmanaged", originalPath: file, runtime: meta.runtime ?? null, cwd: meta.cwd ?? null, sessionId: meta.sessionId,
    ...(meta.reason ? { reason: meta.reason } : {}),
  };
  await writeFile(join(dest, ".meta.json"), JSON.stringify(record, null, 2));
  await rm(file, { force: true });
  return dest;
}

/** 用户手动恢复过的会话：sessionId → 恢复时刻（ISO）。自动归档跳过这些，恢复出来的不会第二天又被收走 */
const RESTORED_INDEX = statePath("restored-sessions.json");

/** 读恢复清单；文件坏了就抛——宁可这一轮一个都不归档，也不能把用户恢复过的又收走 */
async function readRestored(path: string = RESTORED_INDEX): Promise<Record<string, string>> {
  const r = await readJsonState(path);
  if (r.status === "missing") return {};
  if (r.status === "corrupt") throw new Error(`${path} 已损坏（${r.error}），本轮不做自动归档`);
  return r.data && typeof r.data === "object" ? (r.data as Record<string, string>) : {};
}

// 只有 bridge 进程写这份清单（恢复路由）；同进程里的并发恢复排成一队，免得读改写互相覆盖
let restoredChain: Promise<unknown> = Promise.resolve();

function markRestored(sessionId: string, at: Date, path: string = RESTORED_INDEX): Promise<void> {
  const run = restoredChain.then(async () => {
    const cur = await readRestored(path);
    await writeJsonAtomic(path, { ...cur, [sessionId]: at.toISOString() });
  });
  restoredChain = run.catch(() => undefined); // 这一次的失败由 run 抛给调用方；队列本身不能因此卡死
  return run;
}

/**
 * 把未纳管会话的归档搬回原路径（web「恢复」）：先记进恢复清单，再搬文件，搬回来的 mtime 改成现在，最后删归档目录。
 * 不改 mtime 的话 rename 带回来的是归档那一刻的时间，超过 7 天的归档一恢复，下一轮自动归档就又收走了。
 * 单个会话文件直接回原路径；多个（子会话目录等）放在原文件同级的同名目录下。
 */
export async function restoreUnmanagedArchive(
  dir: string,
  meta: { originalPath: string; sessionId: string },
  opts: { now?: number; restoredIndex?: string } = {},
): Promise<void> {
  const when = new Date(opts.now ?? Date.now());
  await markRestored(meta.sessionId, when, opts.restoredIndex);
  const original = meta.originalPath;
  await mkdir(dirname(original), { recursive: true });
  const files = (await readdir(dir)).filter((f) => f !== ".meta.json");
  for (const f of files) {
    const target = files.length === 1 ? original : `${original.replace(/\.jsonl$/, "")}/${f}`;
    await mkdir(dirname(target), { recursive: true });
    await rename(join(dir, f), target);
    await utimes(target, when, when);
  }
  await rm(dir, { recursive: true, force: true });
}

/** Codex 子线程多久没写就收进归档 */
export const CODEX_SUB_IDLE_DAYS = 7;

interface SweepOpts {
  /** registry 里所有 agent（含大总管）挂着的会话：线程本身、它的父线程或根线程在里面就不动 */
  keep: ReadonlySet<string>;
  now?: number;
  idleDays?: number;
  codexRoot?: string;
  archiveRoot?: string;
  /** Codex 的线程写锁目录，缺省是 codexRoot 旁边的 thread-writer-locks */
  locksDir?: string;
  restoredIndex?: string;
}

/**
 * 这个子线程现在不能收：线程本身、直接父线程、根线程任一被 agent 挂着，或正被 Codex 进程持有写锁
 * （锁文件只在线程加载期间存在，释放即删）。父线程还活着时可能随时唤回子线程；进程还开着 rollout 时删掉原件，
 * 后续写入会落进已删除的 inode，悄无声息地丢掉。
 */
function isPinned(p: Record<string, any>, sid: string, opts: SweepOpts, locksDir: string): boolean {
  const related = [sid, codexSubOf(p).parentId, String(p.session_id ?? "")].filter((id) => id && isValidSessionId(id));
  return related.some((id) => opts.keep.has(id) || existsSync(join(locksDir, `${id}.lock`)));
}

/**
 * Codex 的子线程（subagent 做完一件事就停、自动审查每审一次新开一条）结束后不会再被写，Codex 自己又从不清理，
 * 有的机器两个月攒了 355 个；`codex exec` 的一次性会话（isCodexOneShot）同理。这里把 idleDays 天没写过的这两类收进归档（可恢复）；
 * 人开的主会话、被挂着 / 被锁着的（isPinned）、用户恢复过的一律不动。开关在 config.json autoArchiveCodexSubs（缺省关，archive-sweeper 判）。单个文件失败只记一笔。
 */
export async function sweepIdleCodexSubSessions(opts: SweepOpts): Promise<{ archived: number; bytes: number }> {
  const codexRoot = opts.codexRoot ?? codexRolloutRoot();
  const locksDir = opts.locksDir ?? join(dirname(codexRoot), "thread-writer-locks");
  const cutoff = (opts.now ?? Date.now()) - (opts.idleDays ?? CODEX_SUB_IDLE_DAYS) * 86_400_000;
  const restored = await readRestored(opts.restoredIndex);
  let archived = 0;
  let bytes = 0;
  for (const file of listCodexSessionFiles(codexRoot)) {
    try {
      const st = await stat(file);
      if (st.mtimeMs > cutoff) continue;
      const p = await readCodexMetaPayload(file);
      if (!p || !(isCodexSubThread(p) || isCodexOneShot(p))) continue;
      const sid = String(p.id ?? p.session_id ?? "");
      if (restored[sid] || isPinned(p, sid, opts, locksDir)) continue;
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      await archiveUnmanagedFile(file, { sessionId: sid, runtime: "codex", cwd, reason: "codex-sub-idle" }, opts.archiveRoot);
      archived++;
      bytes += st.size;
    } catch (e) {
      console.log(`⚠️ Codex 子会话归档失败（跳过）: ${file}: ${(e as Error).message}`);
    }
  }
  return { archived, bytes };
}

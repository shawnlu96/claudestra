/**
 * 未纳管会话的归档：手动（web 列表左滑 / 抽屉「归档」）与 Codex 子线程的每日自动归档共用一份写法。
 * 单测 tests/unmanaged-archive.test.ts。
 */
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { USER_ARCHIVE_ROOT } from "./session-archive.js";
import { codexSessionsRoot, listCodexSessionFiles, readCodexMeta } from "./codex-session.js";

export interface UnmanagedArchiveMeta {
  sessionId: string;
  runtime?: string | null;
  cwd?: string | null;
}

/**
 * 快照进 archive/archived/<sid>/，旁边写 .meta.json（恢复要知道原路径：cwd 编码不可逆），再删原文件。
 * 用复制不用 rename：副本的 mtime 是归档时刻，归档区按 mtime 算保留期（archive-sweeper pruneArchives）——
 * rename 保留原 mtime，几个月前的子线程一挪进来就会被当成超期清掉。
 */
export async function archiveUnmanagedFile(file: string, meta: UnmanagedArchiveMeta, root: string = USER_ARCHIVE_ROOT): Promise<string> {
  const dest = `${root}/${meta.sessionId}`;
  await mkdir(dest, { recursive: true });
  await copyFile(file, `${dest}/${file.split("/").pop()}`);
  const record = { kind: "unmanaged", originalPath: file, runtime: meta.runtime ?? null, cwd: meta.cwd ?? null, sessionId: meta.sessionId };
  await writeFile(`${dest}/.meta.json`, JSON.stringify(record, null, 2));
  await rm(file, { force: true });
  return dest;
}

/** Codex 子线程多久没写就收进归档 */
export const CODEX_SUB_IDLE_DAYS = 7;

/**
 * Codex 的子线程（subagent 做完一件事就停、自动审查每审一次新开一条）结束后不会再被写，Codex 自己又从不清理，
 * 本机两个月攒了 355 个。这里把 idleDays 天没写过的子线程收进归档（可恢复）；主会话、keep 里的（已纳管 agent 正挂着的）
 * 一律不动。单个文件失败只记一笔，不挡后面的。返回归档条数。
 */
export async function sweepIdleCodexSubSessions(opts: {
  keep: ReadonlySet<string>;
  now?: number;
  idleDays?: number;
  codexRoot?: string;
  archiveRoot?: string;
}): Promise<number> {
  const cutoff = (opts.now ?? Date.now()) - (opts.idleDays ?? CODEX_SUB_IDLE_DAYS) * 86_400_000;
  let archived = 0;
  for (const file of listCodexSessionFiles(opts.codexRoot ?? codexSessionsRoot())) {
    try {
      const st = await stat(file);
      if (st.mtimeMs > cutoff) continue;
      const meta = await readCodexMeta(file);
      if (!meta?.sub || opts.keep.has(meta.sessionId)) continue;
      await archiveUnmanagedFile(file, { sessionId: meta.sessionId, runtime: "codex", cwd: meta.cwd }, opts.archiveRoot);
      archived++;
    } catch (e) {
      console.log(`⚠️ Codex 子会话归档失败（跳过）: ${file}: ${(e as Error).message}`);
    }
  }
  return archived;
}

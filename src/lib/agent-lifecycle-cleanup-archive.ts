/**
 * Archives a surveyed checkout's untracked files (agent-lifecycle-cleanup-scan.ts) under the archive root before the checkout goes:
 *   <archive>/<agent>/worktree-leftovers/<session>/<checkout>-<survey id>/{files/…, manifest.json}
 * The id is a hash of the content, so a retry of the same content lands on the same folder (verified, never rewritten) and changed
 * content gets a new one: an older archive is never overwritten. Copies go to a private `.partial-*` folder first and are checked
 * byte for byte (sha256), by type and permission bits, symlinks by link text without following, with the file count matched; only
 * then is the manifest written and the folder renamed into place (rename refuses an existing target). A crash leaves at most a
 * partial folder nobody reads; the next attempt starts a new one.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, constants, lstat, mkdir, readdir, readFile, readlink, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { agentArchiveDir } from "./session-archive.js";
import { REGENERABLE, type ArchiveEntry, type Survey } from "./agent-lifecycle-cleanup-scan.js";
import { writeJsonAtomic } from "./state-file.js";

export interface ArchiveOwner { agent: string; sessionId: string | null; regAt: number | null; checkout: string }

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const safeSegment = (s: string): string => (/^[\w.-]{1,120}$/.test(s) && s !== "." && s !== ".." ? s : `h-${sha(s).slice(0, 16)}`);

/** The archive folder for this owner and survey; null = the agent name is not a plain folder name under the root. */
export function archiveTarget(root: string, o: ArchiveOwner, s: Survey): string | null {
  const base = agentArchiveDir(o.agent, root);
  if (!base) return null;
  const leaf = `${safeSegment(s.dir.split("/").pop() ?? "checkout")}-${s.id}`;
  return join(base, "worktree-leftovers", safeSegment(o.sessionId || "no-session"), leaf);
}

/** Every entry present in `files` as recorded, and nothing else there. A mismatch is the reason; null = identical. */
async function verify(files: string, entries: readonly ArchiveEntry[]): Promise<string | null> {
  for (const e of entries) {
    const p = join(files, e.path);
    const st = await lstat(p).catch(() => null);
    if (!st) return `${e.path} 不在归档里`;
    const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    if (type !== e.type) return `${e.path} 类型不符（${type} ≠ ${e.type}）`;
    if (e.type !== "symlink" && (st.mode & 0o7777) !== e.mode) return `${e.path} 权限不符`;
    if (e.type === "file" && (st.size !== e.size || sha(await readFile(p)) !== e.sha)) return `${e.path} 内容不符`;
    if (e.type === "symlink" && (await readlink(p)) !== e.link) return `${e.path} 链接目标不符`;
  }
  let count = 0;
  const leaves = async (rel: string): Promise<void> => {
    const names = await readdir(join(files, rel));
    if (!names.length && rel) count++;
    for (const n of names) {
      const p = rel ? `${rel}/${n}` : n;
      if ((await lstat(join(files, p))).isDirectory()) await leaves(p);
      else count++;
    }
  };
  await leaves("");
  return count === entries.length ? null : `归档里有 ${count} 项，清单是 ${entries.length} 项`;
}

/** Copies into a fresh folder; directory permission bits are set last (a read-only source dir would block its own children). */
async function copyAll(src: string, files: string, entries: readonly ArchiveEntry[]): Promise<void> {
  const dirs: ArchiveEntry[] = [];
  for (const e of entries) {
    const to = join(files, e.path);
    await mkdir(e.type === "dir" ? to : join(to, ".."), { recursive: true });
    if (e.type === "dir") { dirs.push(e); continue; }
    if (e.type === "symlink") { await symlink(e.link!, to); continue; }
    await copyFile(join(src, e.path), to, constants.COPYFILE_EXCL);
    await chmod(to, e.mode);
  }
  for (const d of dirs.reverse()) await chmod(join(files, d.path), d.mode);
}

/**
 * Archives the survey's entries; returns the archive folder, or why it could not be guaranteed. An existing folder for the same
 * id counts only when it verifies against this survey; one that does not is reported and left alone.
 */
export async function archiveSurvey(root: string, o: ArchiveOwner, s: Survey, now: number): Promise<{ dir: string } | { why: string }> {
  const final = archiveTarget(root, o, s);
  if (!final) return { why: `agent 名 ${o.agent} 不能当归档目录名` };
  try {
    if (await lstat(final).then(() => true, () => false)) {
      const bad = await verify(join(final, "files"), s.entries);
      return bad ? { why: `归档目录 ${final} 已存在但和现状对不上（${bad}），不覆盖` } : { dir: final };
    }
    const partial = `${final}.partial-${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(join(partial, "files"), { recursive: true });
    await copyAll(s.dir, join(partial, "files"), s.entries);
    const bad = await verify(join(partial, "files"), s.entries);
    if (bad) return { why: `归档核对没过（${bad}），原文件没动；半成品留在 ${partial}` };
    await writeJsonAtomic(join(partial, "manifest.json"), { ...o, archivedAt: now, id: s.id, entries: s.entries, excluded: s.excluded,
      excludedRule: `git 标为 ignored 且名字是 ${REGENERABLE.join(" / ")} 的目录或链接：可再生，不归档只列名` }, { noFollow: true });
    await rename(partial, final);
    return { dir: final };
  } catch (e) {
    return { why: `归档失败，原文件没动：${(e as Error).message}` };
  }
}

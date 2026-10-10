/**
 * Archives a surveyed checkout (agent-lifecycle-cleanup-scan.ts): <archive>/<agent>/worktree-leftovers/<session>/<checkout>-<survey id>/
 * {files/…, manifest.json}. The id hashes the content: a retry lands on the same folder (accepted only when its manifest and files match
 * exactly, never rewritten), changed content gets a new one. Copies go to a `.partial-*` folder, are checked by an lstat walk that never
 * follows a link (no folder below the root may be a symlink), then the manifest is written and the folder renamed into place.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, constants, lstat, mkdir, readdir, readFile, readlink, rename, symlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { agentArchiveDir } from "./session-archive.js";
import { REGENERABLE, type ArchiveEntry, type Survey } from "./agent-lifecycle-cleanup-scan.js";
import { writeJsonAtomic } from "./state-file.js";

export interface ArchiveOwner { agent: string; sessionId: string | null; regAt: number | null; checkout: string }

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const safeSegment = (s: string): string => (/^[\w.-]{1,120}$/.test(s) && s !== "." && s !== ".." ? s : `h-${sha(s).slice(0, 16)}`);
const EXCLUDED_RULE = `git 标为 ignored 的真实目录（不是文件 / 软链）且名字是 ${REGENERABLE.join(" / ")}：可再生，不归档只列名`;

/** The archive folder for this owner and survey; null = the agent name is not a plain folder name under the root. */
export function archiveTarget(root: string, o: ArchiveOwner, s: Survey): string | null {
  const base = agentArchiveDir(o.agent, root);
  if (!base) return null;
  const leaf = `${safeSegment(s.dir.split("/").pop() ?? "checkout")}-${s.id}`;
  return join(base, "worktree-leftovers", safeSegment(o.sessionId || "no-session"), leaf);
}

/** Every folder from below `root` down to `path` that exists is a real directory (a symlink would carry the archive elsewhere). */
async function realChain(root: string, path: string): Promise<string | null> {
  let at = root;
  for (const seg of ["", ...relative(root, path).split(sep)]) {
    at = join(at, seg);
    const st = await lstat(at).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : e));
    if (st === null) return null;
    if (st instanceof Error) return `读不了 ${at}：${st.message}`;
    if (!st.isDirectory()) return `${at} 不是真实目录（${st.isSymbolicLink() ? "软链" : "文件"}），不跟`;
  }
  return null;
}

const record = (e: ArchiveEntry) => JSON.stringify([e.type, e.type === "symlink" ? 0 : e.mode, e.size, e.sha, e.link ?? null]);

/** lstat walk of `files` (never follows a link) against the entries: same paths, types, permission bits, bytes, link text. */
async function verify(files: string, entries: readonly ArchiveEntry[]): Promise<string | null> {
  const want = new Map(entries.map((e) => [e.path, record(e)]));
  let seen = 0;
  const walk = async (rel: string): Promise<string | null> => {
    for (const n of (await readdir(join(files, rel))).sort()) {
      const p = rel ? `${rel}/${n}` : n, at = join(files, p), st = await lstat(at);
      const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      const link = type === "symlink" ? await readlink(at) : undefined;
      const got: ArchiveEntry = { path: p, type: type as ArchiveEntry["type"], mode: st.mode & 0o7777, ignored: false,
        size: type === "file" ? st.size : link !== undefined ? Buffer.byteLength(link) : 0,
        sha: type === "file" ? sha(await readFile(at)) : link !== undefined ? sha(link) : "", ...(link !== undefined ? { link } : {}) };
      if (!want.has(p)) return `归档里多了 ${p}`;
      if (want.get(p) !== record(got)) return `${p} 和清单不符（类型 / 权限 / 内容 / 链接）`;
      seen++;
      if (type === "dir") { const bad = await walk(p); if (bad) return bad; }
    }
    return null;
  };
  const bad = await walk("");
  return bad ?? (seen === entries.length ? null : `归档里有 ${seen} 项，清单是 ${entries.length} 项`);
}

/** The manifest of an existing folder names this owner, this attempt and this exact list and exclusion rule. */
async function manifestMatches(final: string, o: ArchiveOwner, s: Survey): Promise<string | null> {
  const p = join(final, "manifest.json"), st = await lstat(p).catch(() => null);
  if (!st?.isFile()) return "没有 manifest（或不是普通文件）";
  let m: Record<string, unknown>;
  try { m = JSON.parse(await readFile(p, "utf8")); } catch (e) { return `manifest 读不懂：${(e as Error).message}`; }
  const mine = { agent: o.agent, sessionId: o.sessionId, regAt: o.regAt, checkout: o.checkout, id: s.id, entries: s.entries, excluded: s.excluded,
    excludedRule: EXCLUDED_RULE };
  const bad = Object.entries(mine).find(([k, v]) => JSON.stringify(m[k]) !== JSON.stringify(v));
  return bad ? `manifest 的 ${bad[0]} 对不上` : null;
}

/** Copies into a fresh folder in survey order (parents first); directory permission bits are set last, deepest first. */
async function copyAll(src: string, files: string, entries: readonly ArchiveEntry[]): Promise<void> {
  const dirs: ArchiveEntry[] = [];
  for (const e of entries) {
    const to = join(files, e.path);
    await mkdir(e.type === "dir" ? to : dirname(to), { recursive: true });
    if (e.type === "dir") { dirs.push(e); continue; }
    if (e.type === "symlink") { await symlink(e.link!, to); continue; }
    await copyFile(join(src, e.path), to, constants.COPYFILE_EXCL);
    await chmod(to, e.mode);
  }
  for (const d of dirs.reverse()) await chmod(join(files, d.path), d.mode);
}

/**
 * Archives the survey's entries; returns the archive folder, or why it could not be guaranteed (the originals are never touched here).
 * An existing folder for the same id counts only when its whole path is real directories and manifest + files match this survey.
 */
export async function archiveSurvey(root: string, o: ArchiveOwner, s: Survey, now: number): Promise<{ dir: string; rootId: string } | { why: string }> {
  const final = archiveTarget(root, o, s);
  if (!final) return { why: `agent 名 ${o.agent} 不能当归档目录名` };
  try {
    const chain = await realChain(root, join(final, "files"));
    if (chain) return { why: `归档路径不安全，不写也不认：${chain}` };
    await mkdir(root, { recursive: true });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) return { why: "归档根不是真实目录，不跟软链" };
    const rootId = `${rootStat.dev}:${rootStat.ino}`;
    if (await lstat(final).then(() => true, () => false)) {
      const bad = (await manifestMatches(final, o, s)) ?? (await verify(join(final, "files"), s.entries));
      return bad ? { why: `归档目录 ${final} 已存在但和现状对不上（${bad}），不覆盖` } : { dir: final, rootId };
    }
    const partial = `${final}.partial-${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(join(partial, "files"), { recursive: true });
    const moved = await realChain(root, join(partial, "files"));
    if (moved) return { why: `归档路径建好后变成不安全，原文件没动：${moved}` };
    await copyAll(s.dir, join(partial, "files"), s.entries);
    const bad = await verify(join(partial, "files"), s.entries);
    if (bad) return { why: `归档核对没过（${bad}），原文件没动；半成品留在 ${partial}` };
    await writeJsonAtomic(join(partial, "manifest.json"), { agent: o.agent, sessionId: o.sessionId, regAt: o.regAt, checkout: o.checkout,
      archivedAt: now, id: s.id, entries: s.entries, excluded: s.excluded, excludedRule: EXCLUDED_RULE }, { noFollow: true });
    const currentRoot = await lstat(root);
    if (!currentRoot.isDirectory() || `${currentRoot.dev}:${currentRoot.ino}` !== rootId) return { why: "归档根身份变了，原文件没动" };
    await rename(partial, final);
    const after = (await realChain(root, join(final, "files"))) ?? (await manifestMatches(final, o, s)) ?? (await verify(join(final, "files"), s.entries));
    return after ? { why: `归档放好后复核没过（${after}），原文件没动` } : { dir: final, rootId };
  } catch (e) {
    return { why: `归档失败，原文件没动：${(e as Error).message}` };
  }
}

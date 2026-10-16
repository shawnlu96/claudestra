/**
 * StateFs 的 node:fs 实现。只有「不存在」被翻译成 null,其余错误(权限、EXDEV 等)原样抛出,
 * 否则一个读不到的根会被当成空根,进而让空根覆盖旧根。
 */

import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, symlink, unlink } from "fs/promises";
import type { NodeKind, NodeStat, StateFs } from "./types.ts";

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function kindOf(s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): NodeKind {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isDirectory()) return "dir";
  return s.isFile() ? "file" : "other";
}

export const nodeStateFs: StateFs = {
  lstat: (p) => orNull(async (): Promise<NodeStat> => {
    const s = await lstat(p);
    return { kind: kindOf(s), mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  }),
  readdir: (p) => readdir(p),
  readFile: (p) => orNull(() => readFile(p)),
  realpath: (p) => orNull(() => realpath(p)),
  readlink: (p) => orNull(() => readlink(p)),
  rename: (a, b) => rename(a, b),
  symlink: (target, p) => symlink(target, p, "dir"),
  unlink: (p) => unlink(p),
  mkdir: async (p, mode) => { await mkdir(p, { mode }); },
};

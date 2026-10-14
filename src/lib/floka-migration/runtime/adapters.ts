/**
 * runtime 别名的两个真实适配器。文件系统走 node:fs;tmux 查询不在这里起进程——调用方把 tmux-helper 的
 * 查询函数(tmuxRaw)传进来,这里只发一条只读的 display-message,所以不会手写 socket 目标,也不会拉起 server。
 */

import { constants } from "fs";
import { link, lstat, open, readlink, realpath, rename, stat, symlink, unlink } from "fs/promises";
import { basename, dirname, join } from "path";
import type { AliasFs, EntryHold, EntryKind, ServerProbe } from "./types.ts";

const missing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(String((e as { code?: unknown } | null)?.code));

/** 只打开这一项本身、不跟随软链也不读内容:Linux 的 O_PATH|O_NOFOLLOW、macOS 的 O_SYMLINK;别的平台不占 */
const HOLD_FLAGS: number | null =
  process.platform === "linux" ? 0o10000000 | constants.O_NOFOLLOW
  : process.platform === "darwin" && constants.O_SYMLINK ? constants.O_SYMLINK | constants.O_RDONLY
  : null;

async function entryId(path: string): Promise<string | null> {
  try {
    const s = await lstat(path);
    return `${s.dev}:${s.ino}`;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** hold 用到的两步 IO;测试注入假的来复现「open 与 lstat 之间被换」的窗口 */
export interface HoldIo {
  /** 按 HOLD_FLAGS 打开这一项本身;平台不支持或打不开回 null */
  open(path: string): Promise<{ stat(): Promise<{ dev: number; ino: number }>; close(): Promise<void> } | null>;
  entryId(path: string): Promise<string | null>;
}

const nodeHoldIo: HoldIo = {
  open: (path) => (HOLD_FLAGS === null ? Promise.resolve(null) : open(path, HOLD_FLAGS).catch(() => null)), // 打不开就按占不住处理,pinned=false 让调用方拒绝删
  entryId,
};

const closeQuietly = async (fd: { close(): Promise<void> }): Promise<void> => {
  await fd.close().catch(() => undefined); // 关不掉也只是占位提前失效,判断已作出
};

/**
 * 占住这一项并给标识。标识取自打开的描述符(fstat),不取自路径:open 与路径查询之间别名被换时,
 * 返回的仍是真被占住的那一项,路径上的替代项与它对不上,之后的所有权核对自然拒绝。
 * 打不开(平台不支持、无权限、刚好不在)时不占,pinned=false:这时不担保标识不被复用,调用方须拒绝据此删除。
 */
export async function holdWith(io: HoldIo, path: string): Promise<EntryHold | null> {
  const fd = await io.open(path);
  if (fd === null) {
    const id = await io.entryId(path);
    return id === null ? null : { id, pinned: false, release: async () => undefined };
  }
  try {
    const s = await fd.stat();
    return { id: `${s.dev}:${s.ino}`, pinned: true, release: () => closeQuietly(fd) };
  } catch (e) {
    await closeQuietly(fd);
    throw e;
  }
}

export const nodeAliasFs: AliasFs = {
  async kind(path): Promise<EntryKind> {
    try {
      const s = await lstat(path);
      return s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : "other";
    } catch (e) {
      if (missing(e)) return "missing";
      throw e;
    }
  },
  resolve: (path) => realpath(path),
  async fileId(path) {
    try {
      const s = await stat(path);
      return `${s.dev}:${s.ino}`;
    } catch (e) {
      if (missing(e) || String((e as { code?: unknown }).code) === "ELOOP") return null;
      throw e;
    }
  },
  entryId,
  hold: (path) => holdWith(nodeHoldIo, path),
  readlink: (path) => readlink(path),
  symlink: (target, path) => symlink(target, path, "dir"),
  unlink: (path) => unlink(path),
  rename: (from, to) => rename(from, to),
  link: (existing, path) => link(existing, path),
};

/** tmux-helper 的 tmuxRaw 形状:给参数,回 stdout(失败回空串) */
export type TmuxQuery = (args: string[]) => Promise<string>;

/**
 * 用 tmux-helper 的查询认 server:标识 = server pid + 启动时间。tmuxRaw 固定连本进程的 socket,
 * 所以先比 server 自报的 socket 路径:被问的路径解析软链后不是它,就答不了(null)。
 * socket 文件本身不做 realpath(Bun 对 unix socket 报 EOPNOTSUPP),解析父目录再接文件名。
 */
export function tmuxServerProbe(query: TmuxQuery, fs: Pick<AliasFs, "resolve"> = nodeAliasFs): ServerProbe {
  const canon = async (p: string): Promise<string | null> => {
    try {
      return join(await fs.resolve(dirname(p)), basename(p));
    } catch {
      return null; // 目录不存在或解析不了:当作答不了
    }
  };
  return {
    async identify(socketPath) {
      const [pid, started, reported] = (await query(["display-message", "-p", "#{pid}\t#{start_time}\t#{socket_path}"])).split("\t");
      if (!pid || !started || !reported || !/^\d+$/.test(pid)) return null;
      const [asked, actual] = [await canon(socketPath), await canon(reported)];
      return asked !== null && asked === actual ? `tmux:${pid}:${started}` : null;
    },
  };
}

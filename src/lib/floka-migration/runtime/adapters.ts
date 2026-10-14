/**
 * runtime 别名的两个真实适配器。文件系统走 node:fs;tmux 查询不在这里起进程——调用方把 tmux-helper 的
 * 查询函数(tmuxRaw)传进来,这里只发一条只读的 display-message,所以不会手写 socket 目标,也不会拉起 server。
 */

import { lstat, realpath, stat, symlink, unlink } from "fs/promises";
import { basename, dirname, join } from "path";
import type { AliasFs, EntryKind, ServerProbe } from "./types.ts";

const missing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(String((e as { code?: unknown } | null)?.code));

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
  async entryId(path) {
    try {
      const s = await lstat(path);
      return `${s.dev}:${s.ino}`;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  },
  symlink: (target, path) => symlink(target, path, "dir"),
  unlink: (path) => unlink(path),
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

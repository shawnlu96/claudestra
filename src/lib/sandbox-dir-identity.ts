/**
 * 自有目录身份与比对的唯一出处：真实路径 + dev/ino + 出生时间（birth，bigint stat 的纳秒值，十进制串；文件系统报 0 / 给不出就不记）。
 * 同路径同文件系统删了重建时文件系统可能把旧 inode 给新目录，只剩 birth 能区分新旧。
 * - 路径 / dev / ino 任一不同，或双方都有 birth 而不等：不是同一个（birth 不等 = 同路径重建，文字里说清）。
 * - 三项相同、有一方没有 birth（旧登记 / 文件系统给不出）：重启与占用检查（use "keep"）沿用现状当同一个；
 *   要删根外目录（use "delete"）认不出，不删、保留（fail-closed）。
 * 调用方只传用途，不各写一套。tests/sandbox-dir-identity.test.ts
 */
import { type BigIntStats, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalPath } from "./sandbox.js";

/** 创建端显式登记的自有临时目录：真实路径 + dev/ino（+ 出生时间），同名换了一个目录就对不上 */
export interface OwnedDir { path: string; dev: number; ino: number; birth?: string }

/** 判定用途：keep = 重启沿用 / 占用检查；delete = 删根外目录前的身份确认 */
export type DirUse = "keep" | "delete";

/** stat 入口；测试替换 read 构造 inode 复用 / 出生时间缺失（Linux 上 ext4 复用 inode 不可控） */
export const dirStat = { read: (path: string): BigIntStats | undefined => lstatSync(path, { bigint: true, throwIfNoEntry: false }) };

/** 此刻的目录身份；不在 = null，软链 / 不是目录抛错 */
export function dirIdentity(path: string): OwnedDir | null {
  const st = dirStat.read(path);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`自有目录 ${path} 不是普通目录（软链 / 文件）`);
  const id: OwnedDir = { path: canonicalPath(path), dev: Number(st.dev), ino: Number(st.ino) };
  if (st.birthtimeNs > 0n) id.birth = String(st.birthtimeNs);
  return id;
}

/** 登记身份 vs 此刻身份；null = 同一个 */
export function dirMismatch(d: OwnedDir, now: OwnedDir, use: DirUse = "keep"): string | null {
  if (now.path !== d.path || now.dev !== d.dev || now.ino !== d.ino) return `目录 ${d.path} 已不是登记的那个`;
  if (d.birth !== undefined && now.birth !== undefined) return d.birth === now.birth ? null : `目录 ${d.path} 已被替换（同路径重建，inode 被复用）`;
  return use === "delete" ? `目录 ${d.path} 缺出生时间，认不出是不是登记的那个，保留不删` : null;
}

/** 目录此刻还是不是登记的那个：不在 = gone；软链 / 换了目录 / 读不了 = 说不清 */
export function dirVerdict(d: OwnedDir, use: DirUse = "keep"): "same" | "gone" | string {
  try {
    const now = dirIdentity(d.path);
    return now ? dirMismatch(d, now, use) ?? "same" : "gone";
  } catch (e) {
    return (e as Error).message;
  }
}

const BIRTH_RE = /^[1-9][0-9]{0,30}$/;

/** 登记文件里的目录项；没有 birth 的旧记录照收 */
export const validDir = (x: unknown): x is OwnedDir => {
  const o = x as OwnedDir;
  return typeof o?.path === "string" && isAbsolute(o.path) && Number.isFinite(o.dev) && Number.isFinite(o.ino) &&
    typeof o.dev === "number" && typeof o.ino === "number" && (o.birth === undefined || (typeof o.birth === "string" && BIRTH_RE.test(o.birth)));
};

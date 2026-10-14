/**
 * 删别名的所有权协议。按路径「先核对、再 unlink」中间总有窗口(核对读到正确目标后、unlink 之前别名可被换掉),
 * 所以这里不按路径删:先把别名位置上此刻的那一项原子 rename 到同目录的暂存名(随机名,只有本次调用知道),
 * 再核暂存的这一项是不是本次核对过的那条软链——是才删暂存名;不是就放回别名位置,放回不覆盖任何后来者。
 * 被换在 rename 之前:取走的是替代项,核不过,放回;被放在 rename 之后:本库不碰。
 */

import { randomUUID } from "crypto";
import { basename, dirname, join } from "path";
import type { AliasFs, Refusal } from "./types.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const conflict = (detail: string): Refusal => ({ code: "conflict-entry", scope: "alias", detail });

/** 删成功 refusal 为空;changed 如实说本次是否动过文件系统(取走后没能放回也算) */
export interface Removal {
  refusal?: Refusal;
  changed: boolean;
}

/** 暂存的这一项仍是 entry 那一条(lstat 标识不变)、仍是软链、仍解析到 currentReal */
async function owned(fs: AliasFs, path: string, currentReal: string, entry: string): Promise<boolean> {
  try {
    return (await fs.entryId(path)) === entry && (await fs.kind(path)) === "symlink" && (await fs.resolve(path)) === currentReal;
  } catch {
    return false;
  }
}

/**
 * 放回且不覆盖:软链按原目标在原位重建、其余非目录硬链回去(目标已存在时两者都原子失败,硬链保留原 inode),
 * 成功后再删暂存名。目录只能 rename 回去:先确认原位为空;rename 本身遇到非空目录或非目录也会失败,
 * 剩下的极窄情形只可能顶掉别人在这一瞬新建的空目录。放不回就留在暂存名,返回原因。
 */
async function putBack(fs: AliasFs, parked: string, aliasDir: string): Promise<string | undefined> {
  try {
    const kind = await fs.kind(parked);
    if (kind === "dir") {
      if ((await fs.kind(aliasDir)) !== "missing") return "别名位置已被别人占用";
      await fs.rename(parked, aliasDir);
      return undefined;
    }
    if (kind === "symlink") await fs.symlink(await fs.readlink(parked), aliasDir);
    else await fs.link(parked, aliasDir);
    await fs.unlink(parked);
    return undefined;
  } catch (e) {
    return errText(e);
  }
}

/** 只删本次核对过的那条软链(entry = 核对时的 lstat 标识);别的一概原样保留,拒绝以 refusal 返回,不抛 */
export async function unlinkOwned(fs: AliasFs, aliasDir: string, currentReal: string, entry: string | null): Promise<Removal> {
  // 预检只为常见情形少一次挪动;真正的所有权保证在取走之后的核对
  if (entry === null || (await fs.entryId(aliasDir)) !== entry) {
    return { changed: false, refusal: conflict(`别名 ${aliasDir} 已不在、已被替换或未能占住,不是本次核对过的那条软链,不删`) };
  }
  const parked = join(dirname(aliasDir), `.${basename(aliasDir)}.floka-unlink-${randomUUID()}`);
  try {
    await fs.rename(aliasDir, parked);
  } catch (e) {
    return { changed: false, refusal: conflict(`取走别名 ${aliasDir} 失败,未删:${errText(e)}`) };
  }
  if (await owned(fs, parked, currentReal, entry)) {
    try {
      await fs.unlink(parked);
      return { changed: true };
    } catch (e) {
      return { changed: true, refusal: conflict(`别名已从 ${aliasDir} 移到 ${parked},但删除失败:${errText(e)}`) };
    }
  }
  const failed = await putBack(fs, parked, aliasDir);
  const detail = `别名 ${aliasDir} 已被替换,不是本次核对过的那条软链,不删`;
  if (failed) return { changed: true, refusal: conflict(`${detail};替代项未能放回,暂存在 ${parked}:${failed}`) };
  return { changed: false, refusal: conflict(`${detail},已原样放回`) };
}

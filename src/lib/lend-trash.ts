/**
 * 出借目录的回收站：同步 rmSync 一份带 node_modules 的副本（约 2 万文件）会把调度服务主线程卡 1–3 秒，改成先 rename 进同卷的回收目录
 * （瞬间、原路径立刻没了），再在线程池里异步删。叶子模块：lend-clone / lend-claude-worker 都用它，它不 import 别的 lend 模块（否则成环）。
 * tests/lend-clone-trash.test.ts。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

/** 删目录的两步（测试注入）：rename 必须同步完成，rm 在线程池里跑 */
export interface TrashFs { rename: (from: string, to: string) => void; rm: (path: string) => Promise<void> }
const realTrashFs: TrashFs = { rename: renameSync, rm: (p) => rm(p, { recursive: true, force: true }) };
const pending = new Set<Promise<void>>();
let seq = 0;

function trashDirOf(trash: string): string {
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  if (lstatSync(trash).isSymbolicLink()) throw new Error(`回收目录 ${trash} 是软链，不往里挪、不清`);
  return trash;
}

function rmLater(path: string, fs: TrashFs): void {
  // 删不掉只记一行：东西已经不在原路径上，残留由下次启动的 sweepTrash 再删
  const p: Promise<void> = fs.rm(path).catch((e) => console.error(`[lend] 后台删除 ${path} 失败，下次启动再清：${(e as Error).message}`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** trash 必须和 path 在同一个卷（调用方都放在各自 root 之下），跨卷 rename 会 EXDEV 抛出、原目录不动 */
export function trashAway(path: string, trash: string, fs: TrashFs = realTrashFs): string {
  const to = join(trashDirOf(trash), `${basename(path)}-${Date.now()}-${seq++}`);
  fs.rename(path, to);
  rmLater(to, fs);
  return to;
}

/** 启动时清掉上个进程没删完的回收目录（进程退出时后台删除会中断）；回收目录不存在就什么都不做 */
export function sweepTrash(trash: string, fs: TrashFs = realTrashFs): number {
  if (!existsSync(trash)) return 0;
  const names = readdirSync(trashDirOf(trash));
  for (const n of names) rmLater(join(trash, n), fs);
  return names.length;
}

/** 本进程还在跑的后台删除都结束（测试、关停前等它） */
export const trashSettled = (): Promise<unknown> => Promise.all([...pending]);

/**
 * 归档用的两种「只在有新内容时才复制」（session-archive.ts、workflow-archive.ts 共用）：
 *   copyIfLarger  追加式 jsonl：更大 = 更全；缩水 / 丢失不回写
 *   copyIfNewer   会被整个重写的文件（workflow 运行 JSON 跑的过程中可能变小）：源比归档新就覆盖
 * 都不抛：归档是 best-effort，拷不动返回 false。
 */
import { existsSync } from "fs";
import { copyFile, stat } from "fs/promises";

export async function copyIfLarger(src: string, dest: string): Promise<boolean> {
  try {
    const s = await stat(src);
    if (existsSync(dest)) {
      const d = await stat(dest);
      if (d.size >= s.size) return false;
    }
    await copyFile(src, dest);
    return true;
  } catch {
    return false; // 源被 CC 清掉 / 目标盘满：这一份没拷上，下次归档再试
  }
}

export async function copyIfNewer(src: string, dest: string): Promise<boolean> {
  try {
    const s = await stat(src);
    if (existsSync(dest)) {
      const d = await stat(dest);
      if (d.mtimeMs >= s.mtimeMs && d.size === s.size) return false;
    }
    await copyFile(src, dest);
    return true;
  } catch {
    return false; // 同上：best-effort，下次再试
  }
}

/**
 * 归档用的两种「只在有新内容时才复制」（session-archive.ts、workflow-archive.ts 共用），都经临时文件 + rename 落盘：
 * 复制到一半失败或被读到半截，不会弄坏上一份好归档。
 *   copyIfLarger  追加式 jsonl：更大 = 更全；缩水 / 丢失不回写
 *   copyIfChanged 会被整个重写的文件（workflow 运行 JSON 跑的过程中可能变小）：内容不同就镜像源；.json 先解析成功才替换，
 *                 读的前后源变了（正被重写）就重读，三次都不稳就这次放弃
 * 返回 "copied" / "same" / "failed"：失败要让调用方报出来，别和「没变化」混在一起。
 */
import { existsSync } from "fs";
import { readFile, rename, stat, unlink, writeFile } from "fs/promises";

export type CopyOutcome = "copied" | "same" | "failed";

async function atomicWrite(dest: string, data: Uint8Array): Promise<void> {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => undefined); // 临时文件可能根本没写出来：删不掉无所谓，原归档没动
    throw e;
  }
}

/** onError 拿到失败原因（归档要把它写进结果说明，只说「失败」没法排查） */
export async function copyIfLarger(src: string, dest: string, onError?: (e: Error) => void): Promise<CopyOutcome> {
  try {
    const s = await stat(src);
    if (existsSync(dest) && (await stat(dest)).size >= s.size) return "same";
    await atomicWrite(dest, await readFile(src));
    return "copied";
  } catch (e) {
    onError?.(e as Error);
    return "failed"; // 源被 CC 清掉 / 盘满 / 没权限：原归档不动，调用方记失败，下次再试
  }
}

/** 读一份「读的过程中没被改过」的源内容；三次都在变 → null */
async function stableRead(src: string): Promise<Buffer | null> {
  for (let i = 0; i < 3; i++) {
    const before = await stat(src);
    const buf = await readFile(src);
    const after = await stat(src);
    if (before.mtimeMs === after.mtimeMs && before.size === after.size && buf.length === after.size) return buf;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function copyIfChanged(src: string, dest: string): Promise<CopyOutcome> {
  try {
    const buf = await stableRead(src);
    if (!buf) return "failed";
    if (src.endsWith(".json")) JSON.parse(buf.toString("utf8")); // 半截 / 坏 JSON 不许替换上一份好归档
    if (existsSync(dest) && Buffer.compare(await readFile(dest), buf) === 0) return "same";
    await atomicWrite(dest, buf);
    return "copied";
  } catch {
    return "failed"; // 解析失败 / 读写失败：原归档不动，调用方记失败
  }
}

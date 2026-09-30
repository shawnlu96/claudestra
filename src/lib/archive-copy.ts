/**
 * 归档用的两种「只在有新内容时才复制」（session-archive.ts、workflow-archive.ts 共用），都经临时文件 + rename 落盘：
 * 复制到一半失败或被读到半截，不会弄坏上一份好归档。
 *   copyIfLarger  追加式 jsonl：更大 = 更全；缩水 / 丢失不回写
 *   copyIfChanged 会被整个重写的文件（workflow 运行 JSON 跑的过程中可能变小）：内容不同就镜像源；.json 先解析成功才替换，
 *                 读的前后源变了（正被重写）就重读，三次都不稳就这次放弃
 * 返回 "copied" / "same" / "failed"：失败要让调用方报出来，别和「没变化」混在一起。
 * `.zst` 源（Codex 满 7 天压缩的 rollout）按解压后的内容比、落盘：先看帧头声明的大小，归档已不小于它就不解；
 * 否则流式解到临时文件再 rename（lib/zstd-file.ts）。解压失败 / 超上限 = "failed"，不当「没变化」，不留临时文件。
 */
import { existsSync } from "fs";
import { readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { decompressZstdToFile, zstdContentSize } from "./zstd-file.js";

/**
 * .zst 解压后的上限。真实 Codex rollout 在几 MB 到几百 MB；解压是流式落盘，这个数限的是磁盘占用和 sweep 的耗时，
 * 超过它更可能是损坏或解压炸弹（压缩比没有上限）。调大前先确认归档盘够用（tests/zstd-file.test.ts）。
 */
const ZSTD_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

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

/** 已有归档的大小；不存在 = null。目标被占成目录之类要报错：只比大小会误报「已是最新」，实际没有可读的归档 */
async function destSize(dest: string): Promise<number | null> {
  if (!existsSync(dest)) return null;
  const d = await stat(dest);
  if (!d.isFile()) throw new Error(`归档目标不是普通文件：${dest}`);
  return d.size;
}

async function copyZstdIfLarger(src: string, dest: string, max: number): Promise<CopyOutcome> {
  const have = await destSize(dest);
  const declared = await zstdContentSize(src);
  if (declared !== null && have !== null && have >= declared) return "same"; // 冷段每日 sweep 走这里：零解压
  if (declared !== null && declared > max) throw new Error(`.zst 解压超过上限：帧头声明 ${declared} 字节 > ${max}`);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    const n = await decompressZstdToFile(src, tmp, max);
    const now = await destSize(dest);
    if (now !== null && now >= n) {
      await unlink(tmp);
      return "same";
    }
    await rename(tmp, dest);
    return "copied";
  } catch (e) {
    await unlink(tmp).catch(() => undefined); // 临时文件可能根本没建出来：删不掉无所谓，原归档没动，错误照样抛
    throw e;
  }
}

/** onError 拿到失败原因（归档要把它写进结果说明，只说「失败」没法排查）；zstdMax 只给测试调小 */
export async function copyIfLarger(src: string, dest: string, onError?: (e: Error) => void, zstdMax = ZSTD_ARCHIVE_MAX_BYTES): Promise<CopyOutcome> {
  try {
    if (src.endsWith(".zst")) return await copyZstdIfLarger(src, dest, zstdMax);
    const s = await stat(src);
    const have = await destSize(dest);
    if (have !== null && have >= s.size) return "same";
    await atomicWrite(dest, await readFile(src));
    return "copied";
  } catch (e) {
    onError?.(e as Error);
    return "failed"; // 源被 CC 清掉 / 盘满 / 没权限 / .zst 坏或超上限：原归档不动，调用方记失败，下次再试
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

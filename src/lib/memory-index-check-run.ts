/**
 * 记忆索引体积检查的运行层(agents-MEMIDX1):读机器级开关、读 MEMORY.md 的原始字节、落最近一次检查记录。
 * 只读用户的记忆目录,写只发生在状态目录。SessionStart hook(src/hooks/recall-hook.ts)是唯一调用方,
 * 所以这里任何一步失败都按「这次不检查」处理,不抛给 hook。见 docs/architecture/memory-index-check.md。
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { checkMemoryIndex, MEMORY_INDEX_MAX_BYTES, memoryIndexNotice, validMemoryIndexMaxBytes } from "./memory-index-check.js";
import type { MemoryIndexLine } from "./memory-index-check.js";
import { statePath } from "./paths.js";
import type { DigestMode } from "./pm-digest.js";
import { memoryDir, projectSlug } from "./session-recall.js";
import { parseState, writeTextAtomicSync } from "./state-file.js";

/** 与 PM 摘要同一套三档:off 不检查不记录,observe 只记录不提示,on 只提示不记录 */
type MemoryIndexMode = DigestMode;

interface MemoryIndexConfig {
  mode: MemoryIndexMode;
  maxBytes: number;
}

/** 最近一次检查的记录(每个工作目录一份,覆盖式)。只有数字和行号,不含索引正文 */
interface MemoryIndexRecord {
  at: number;
  cwd: string;
  file: string;
  source: string;
  mode: MemoryIndexMode;
  totalBytes: number;
  maxBytes: number;
  overBytes: number;
  longest: MemoryIndexLine[];
}

const memoryIndexModePath = (): string => statePath("memory-index-mode.json");
const RECORD_DIR = "memory-index-check";
/** 开关文件只有两个字段,超过这个大小的不是它该有的样子,按坏配置算,也不整个读进来 */
const CONFIG_MAX_BYTES = 64 * 1024;

/**
 * 只读普通文件,且不会卡住:O_NONBLOCK 打开(FIFO 没有写者时同步 open 会一直等,try/catch 解不开),
 * 类型在打开的 fd 上核,不是先 stat 再按路径读。不是普通文件或超过 maxBytes 返回 null;不存在照常抛 ENOENT。
 */
function readRegularFileSync(path: string, maxBytes: number = Infinity): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= maxBytes ? readFileSync(fd) : null;
  } finally {
    closeSync(fd);
  }
}

const isMode = (v: unknown): v is MemoryIndexMode => v === "off" || v === "observe" || v === "on";

/**
 * 机器级开关:文件不存在 → observe + 缺省阈值;字段缺省同理。读不出、不是普通文件、不是对象、mode 或 maxBytes 不合法 → off。
 * 坏配置不退回 observe:拿不准用户要什么时,不往状态目录写、也不动 stdout 才是与改前一致的那一档。
 */
function readMemoryIndexConfig(path: string = memoryIndexModePath()): MemoryIndexConfig {
  const off: MemoryIndexConfig = { mode: "off", maxBytes: MEMORY_INDEX_MAX_BYTES };
  let raw: Buffer | null;
  try {
    raw = readRegularFileSync(path, CONFIG_MAX_BYTES);
  } catch (e) {
    // 真的没有这个文件才是「没配」;悬空软链、无权读都算坏配置
    const absent = (e as NodeJS.ErrnoException)?.code === "ENOENT" && !lstatSync(path, { throwIfNoEntry: false });
    return absent ? { mode: "observe", maxBytes: MEMORY_INDEX_MAX_BYTES } : off;
  }
  if (!raw) return off; // 目录 / FIFO / 设备 / 过大
  const r = parseState(raw.toString("utf-8"));
  if (r.status !== "ok" || typeof r.data !== "object" || r.data === null || Array.isArray(r.data)) return off;
  const { mode = "observe", maxBytes = MEMORY_INDEX_MAX_BYTES } = r.data as { mode?: unknown; maxBytes?: unknown };
  return isMode(mode) && validMemoryIndexMaxBytes(maxBytes) ? { mode, maxBytes } : off;
}

/**
 * 落最近一次检查记录(每个工作目录一份:并发启动的会话各写各的,不用读改写同一份)。
 * 落点钉死在状态目录里:记录目录必须是状态目录下的真目录(是软链就不写),记录文件用 noFollow 写——
 * 那个位置若被放了指向别处(比如用户 MEMORY.md)的软链,换掉的是链接本身,不会顺着它覆盖目标。
 */
function writeMemoryIndexRecord(cwd: string, record: MemoryIndexRecord): void {
  mkdirSync(statePath(), { recursive: true });
  const dir = join(realpathSync(statePath()), RECORD_DIR);
  try { mkdirSync(dir); } catch { /* 已经有了(或被占位),下面核它是不是真目录 */ }
  if (!lstatSync(dir).isDirectory()) return;
  writeTextAtomicSync(join(dir, `${projectSlug(cwd)}.json`), JSON.stringify(record, null, 2), { noFollow: true });
}

/**
 * 跑一次检查,返回要注入的那一行提示(不用注入就是空串)。永不抛:
 * 缺文件、读不了、不是普通文件(目录 / FIFO)、状态目录写不进去,都当这次没检查。
 * 写状态目录只发生在 observe;on 只产出提示,off 什么都不做。
 */
export function runMemoryIndexCheck(cwd: string, source: string, now: number = Date.now()): string {
  try {
    const config = readMemoryIndexConfig();
    if (config.mode === "off") return "";
    const file = join(memoryDir(cwd), "MEMORY.md");
    const raw = readRegularFileSync(file);
    if (!raw) return "";
    const check = checkMemoryIndex(raw, config.maxBytes);
    if (config.mode === "on") return memoryIndexNotice(check) ?? "";
    const record: MemoryIndexRecord = { at: now, cwd, file, source, mode: config.mode, ...check };
    writeMemoryIndexRecord(cwd, record);
    return "";
  } catch {
    // 缺文件 / 无权限 / 记录写不进去(磁盘满、目录只读、落点不对):hook 的铁律是不拖累会话启动,这次不检查即可
    return "";
  }
}

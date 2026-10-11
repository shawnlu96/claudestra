/**
 * 记忆索引体积检查的运行层(agents-MEMIDX1):读机器级开关、读 MEMORY.md 的原始字节、落最近一次检查记录。
 * 只读用户的记忆目录,写只发生在状态目录。SessionStart hook(src/hooks/recall-hook.ts)是唯一调用方,
 * 所以这里任何一步失败都按「这次不检查」处理,不抛给 hook。见 docs/architecture/memory-index-check.md。
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { checkMemoryIndex, MEMORY_INDEX_MAX_BYTES, memoryIndexNotice, validMemoryIndexMaxBytes } from "./memory-index-check.js";
import type { MemoryIndexLine } from "./memory-index-check.js";
import { statePath } from "./paths.js";
import type { DigestMode } from "./pm-digest.js";
import { memoryDir, projectSlug } from "./session-recall.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/** 与 PM 摘要同一套三档:off 不检查不记录,observe 只记录,on 记录并注入提示 */
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
/** 按工作目录分文件:并发启动的会话各写各的,不用读改写同一份 */
const memoryIndexRecordPath = (cwd: string): string => statePath("memory-index-check", `${projectSlug(cwd)}.json`);

const isMode = (v: unknown): v is MemoryIndexMode => v === "off" || v === "observe" || v === "on";

/**
 * 机器级开关:文件不存在 → observe + 缺省阈值;字段缺省同理。读不出、不是对象、mode 或 maxBytes 不合法 → off。
 * 坏配置不退回 observe:拿不准用户要什么时,不往状态目录写、也不动 stdout 才是与改前一致的那一档。
 */
function readMemoryIndexConfig(path: string = memoryIndexModePath()): MemoryIndexConfig {
  const off: MemoryIndexConfig = { mode: "off", maxBytes: MEMORY_INDEX_MAX_BYTES };
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { mode: "observe", maxBytes: MEMORY_INDEX_MAX_BYTES };
  if (r.status !== "ok" || typeof r.data !== "object" || r.data === null || Array.isArray(r.data)) return off;
  const { mode = "observe", maxBytes = MEMORY_INDEX_MAX_BYTES } = r.data as { mode?: unknown; maxBytes?: unknown };
  return isMode(mode) && validMemoryIndexMaxBytes(maxBytes) ? { mode, maxBytes } : off;
}

/**
 * 跑一次检查,返回要注入的那一行提示(不用注入就是空串)。永不抛:
 * 缺文件、读不了、不是普通文件(目录 / FIFO)、状态目录写不进去,都当这次没检查。
 */
export function runMemoryIndexCheck(cwd: string, source: string, now: number = Date.now()): string {
  try {
    const config = readMemoryIndexConfig();
    if (config.mode === "off") return "";
    const file = join(memoryDir(cwd), "MEMORY.md");
    if (!statSync(file).isFile()) return "";
    const check = checkMemoryIndex(readFileSync(file), config.maxBytes);
    const notice = config.mode === "on" ? memoryIndexNotice(check) ?? "" : "";
    const record: MemoryIndexRecord = { at: now, cwd, file, source, mode: config.mode, ...check };
    try {
      writeJsonAtomicSync(memoryIndexRecordPath(cwd), record);
    } catch {
      /* 记录只是给人事后看的,写不进去(磁盘满、目录只读)不该连提示一起丢 */
    }
    return notice;
  } catch {
    // 缺文件 / 无权限 / 路径模块加载期的拒绝:hook 的铁律是不拖累会话启动,这次不检查即可
    return "";
  }
}

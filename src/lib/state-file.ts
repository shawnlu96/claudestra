/**
 * 状态文件（~/.claude-orchestrator/*.json 等）的读写底座。
 *
 * 为什么要有它（2026-09 静默失败审查 D7-4 / D6-3）：
 *   - 读：旧写法普遍是 `catch { return 空 }`，把「文件坏了」当成「文件是空的」。
 *     读者这么做只是暂时失明；可**写者**先读后写，就会把「空 + 这次的改动」原子地
 *     写回去——principals.json 一坏，bridge 启动时的 owner 同步就把全部 API/peer
 *     token 永久抹掉；cron.json 一坏，下一次 cron-add 就清空全部任务。
 *     所以读要分三态：不存在 / 损坏 / 正常，损坏时写者必须拒写。
 *   - 写：tmp + rename 原子写手写了八份、还有几处直接覆盖写（principals.json 就是），
 *     半写状态会被别的进程读成「损坏」。这里统一一份：mode 在 open(2) 时就生效，
 *     rename 前再 chmod 一次（对已存在的 tmp 名 mode 不生效）。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync, unlinkSync } from "fs";
import { readFile, writeFile, rename, mkdir, stat, chmod, copyFile, unlink } from "fs/promises";
import { dirname } from "path";

export type StateRead =
  | { status: "missing" }
  | { status: "corrupt"; error: string }
  | { status: "ok"; data: unknown };

/** validate 返回 false = 结构不对，也算损坏（例如 principals 字段不是数组） */
export type StateValidator = (data: unknown) => boolean;

export class StateCorruptError extends Error {
  constructor(readonly path: string, readonly detail: string, readonly backup?: string) {
    super(
      `状态文件损坏，已拒绝覆盖写: ${path}（${detail}）` +
        (backup ? `。原文件已备份到 ${backup}，修好或删掉原文件后重试` : "。修好或删掉原文件后重试"),
    );
    this.name = "StateCorruptError";
  }
}

export function parseState(raw: string, validate?: StateValidator): StateRead {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { status: "corrupt", error: `JSON 解析失败: ${(e as Error).message}` };
  }
  if (validate && !validate(data)) return { status: "corrupt", error: "结构不符合预期" };
  return { status: "ok", data };
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function readJsonState(path: string, validate?: StateValidator): Promise<StateRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    if (isEnoent(e)) return { status: "missing" };
    return { status: "corrupt", error: `读取失败: ${(e as Error).message}` };
  }
  return parseState(raw, validate);
}

export function readJsonStateSync(path: string, validate?: StateValidator): StateRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if (isEnoent(e)) return { status: "missing" };
    return { status: "corrupt", error: `读取失败: ${(e as Error).message}` };
  }
  return parseState(raw, validate);
}

// 同一个坏文件（按 path + mtime 认）只喊一次：读者可能每个请求都读一遍
const reportedCorrupt = new Map<string, number>();
function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/** 读者发现损坏时调用：响亮地报一次（stderr），同一版本的坏文件不重复刷屏。 */
export function reportCorrupt(path: string, error: string, who = "state"): void {
  const m = mtimeOf(path);
  if (reportedCorrupt.get(path) === m) return;
  reportedCorrupt.set(path, m);
  console.error(`🚨 [${who}] 状态文件损坏，按空处理但不会覆盖写: ${path}（${error}）`);
}

function backupName(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.corrupt-${ts}`;
}

/**
 * 写者在写之前调用：磁盘上的文件若损坏就备份一份 `<file>.corrupt-<ts>` 并抛
 * StateCorruptError。不存在 / 正常都放行。
 */
export async function assertWritable(path: string, validate?: StateValidator): Promise<void> {
  const cur = await readJsonState(path, validate);
  if (cur.status !== "corrupt") return;
  let backup: string | undefined;
  try {
    backup = backupName(path);
    await copyFile(path, backup);
  } catch {
    backup = undefined;
  }
  throw new StateCorruptError(path, cur.error, backup);
}

export interface WriteOpts {
  /** 新建时的权限位；已存在的文件 rename 覆盖后也会是这个权限 */
  mode?: number;
  /** 沿用原文件权限（原文件不存在时退回 mode / 默认） */
  preserveMode?: boolean;
  indent?: number;
  trailingNewline?: boolean;
}

let seq = 0;
function tmpName(path: string): string {
  return `${path}.${process.pid}.${seq++}.tmp`;
}

function serialize(data: unknown, opts: WriteOpts): string {
  const s = JSON.stringify(data, null, opts.indent ?? 2);
  return opts.trailingNewline ? s + "\n" : s;
}

async function resolveMode(path: string, opts: WriteOpts): Promise<number | undefined> {
  if (opts.preserveMode) {
    try { return (await stat(path)).mode & 0o777; } catch { /* 不存在 */ }
  }
  return opts.mode;
}

/** 原子写 JSON（tmp + rename，同目录保证同文件系统）。 */
export async function writeJsonAtomic(path: string, data: unknown, opts: WriteOpts = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await resolveMode(path, opts);
  const tmp = tmpName(path);
  try {
    await writeFile(tmp, serialize(data, opts), mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export function writeJsonAtomicSync(path: string, data: unknown, opts: WriteOpts = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = opts.mode;
  if (opts.preserveMode && existsSync(path)) {
    try { mode = statSync(path).mode & 0o777; } catch { /* 用 opts.mode */ }
  }
  const tmp = tmpName(path);
  try {
    writeFileSync(tmp, serialize(data, opts), mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 不在 */ }
    throw e;
  }
}

/** 写者的标准姿势：磁盘上是坏文件就拒写（并备份），否则原子写。 */
export async function writeJsonStateGuarded(
  path: string,
  data: unknown,
  opts: WriteOpts & { validate?: StateValidator } = {},
): Promise<void> {
  await assertWritable(path, opts.validate);
  await writeJsonAtomic(path, data, opts);
}

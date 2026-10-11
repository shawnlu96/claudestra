/**
 * v2.24+ 大总管「这次重启要接回原会话」的交接单。
 *
 * ## 为什么要一张单子
 *
 * 大总管不在 registry 里，启动它的唯一入口是 launcher（bridge 的生命周期端点
 * 直接拒绝 master：「master lifecycle is managed by the launcher」）。所以
 * **谁想重启大总管，都只能把它的 Claude Code 退掉，让 launcher 的 15 秒巡检
 * 把它拉回来**——而 launcher 那条路径历来是「全新会话」，上下文就这么没了。
 *
 * 这张单子就是让那次拉起知道「用 --resume <id> 接回来」。manager 在退它之前
 * 把当前 sessionId 写下，launcher 在 bringUp 时取走（**取走即删**）。
 *
 * ## 为什么带时效、且用完就删
 *
 * 不删的话，一个月后的开机重启会拿着陈年 id 去 resume，把大总管拽回一个早就
 * 不相干的上下文里；而 resume 失败时 Claude Code 会立刻退回 shell，launcher
 * 下一轮又读到同一张单子 → 无限重试。取走即删 + 10 分钟时效，两个问题一起没：
 * 单子只对「刚刚那次有意的重启」有效，失败一次就退化成原来的全新会话。
 *
 * 崩溃 / 开机的行为**没有改变**（没有单子 = 全新会话，与 v2.24 之前一致）。
 */

import { writeJsonAtomic } from "./state-file.js";
import { statePath, stateDirIn } from "./paths.js";
import { readFile, rename, link, unlink } from "fs/promises";

export const MASTER_RESUME_MAX_AGE_MS = 10 * 60_000;

export interface MasterResume {
  sessionId: string;
  recordedAt: number;
  reason?: string;
}

/** Claude Code 的 session id 形状（拼进启动命令前的白名单，宁可当没有也不放行怪东西） */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function masterResumePath(home?: string): string {
  return home === undefined ? statePath("master-resume.json") : `${stateDirIn(home)}/master-resume.json`;
}

/**
 * 解析交接单（纯函数，tests/master-session.test.ts）。
 * 过期 / 形状不对 / id 不合法一律 null —— 调用方据此走「全新会话」。
 */
export function parseMasterResume(
  raw: string,
  now = Date.now(),
  maxAgeMs = MASTER_RESUME_MAX_AGE_MS,
): MasterResume | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const sessionId = typeof j?.sessionId === "string" ? j.sessionId.trim() : "";
  const recordedAt = Number(j?.recordedAt);
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return null;
  // 未来时间戳（改过系统时间 / 手写的单子）按过期处理，不给它无限有效期
  if (now - recordedAt > maxAgeMs || recordedAt - now > maxAgeMs) return null;
  return { sessionId, recordedAt, reason: typeof j?.reason === "string" ? j.reason : undefined };
}

/** 写下交接单（重启大总管之前调用）。id 不合法就当没写，返回 false。 */
export async function writeMasterResume(
  sessionId: string,
  reason: string,
  path = masterResumePath(),
): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId.trim())) return false;
  const body: MasterResume = { sessionId: sessionId.trim(), recordedAt: Date.now(), reason };
  try {
    // 原子写（建目录也在里面）：重启大总管前写到一半被杀，不能留下半截交接单
    await writeJsonAtomic(path, body);
    return true;
  } catch {
    return false;
  }
}

/** takeMasterResume 用到的文件操作；测试注入失败 / barrier，生产走 fs/promises */
export interface MasterResumeIo {
  readFile: (path: string, enc: "utf8") => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  link: (existing: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const FS_IO: MasterResumeIo = { readFile, rename, link, unlink };

let claimSeq = 0;

/** 认领路径：同目录（rename 不跨文件系统）、每次唯一，写者永远不会写到这里 */
function claimPathFor(path: string): string {
  return `${path}.claim-${process.pid}-${claimSeq++}-${Math.random().toString(36).slice(2, 10)}`;
}

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/**
 * 取走交接单：读一次，**无论有效与否都消费掉**（防 resume 失败后无限重试）。
 * 没有 / 过期 / 不合法 → null。
 *
 * 先把当前文件 rename 到本次私有的认领路径，再读认领文件、删认领文件——
 * 只消费自己认领到的那一代：认领之后 writer 原子写下的新一代留在原路径，
 * 不会被这里删掉；并发 consumer 只有一个 rename 成功，其余拿到 ENOENT → null。
 * 认领失败什么都不删；认领后读失败就 link 回原路径（不覆盖已有的新一代）以便下次再取。
 */
export async function takeMasterResume(
  path = masterResumePath(),
  now = Date.now(),
  maxAgeMs = MASTER_RESUME_MAX_AGE_MS,
  io: Partial<MasterResumeIo> = {},
): Promise<MasterResume | null> {
  const fs = { ...FS_IO, ...io };
  const claim = claimPathFor(path);
  try {
    await fs.rename(path, claim);
  } catch {
    return null; // 没有单子 / 被别人认领 / 认领失败：原文件原样不动
  }
  let raw: string;
  try {
    raw = await fs.readFile(claim, "utf8");
  } catch {
    await restoreClaim(fs, claim, path);
    return null;
  }
  await fs.unlink(claim).catch(() => { /* 删不掉也别卡住启动；认领名唯一，不会被当成交接单再读 */ });
  return parseMasterResume(raw, now, maxAgeMs);
}

/** 读失败：把认领到的这一代放回原路径（link 不覆盖后来写下的新一代），再删认领文件 */
async function restoreClaim(fs: MasterResumeIo, claim: string, path: string): Promise<void> {
  try {
    await fs.link(claim, path);
  } catch (e) {
    // 原路径已有新一代：旧的让位；其它失败就把认领文件留着，不丢数据
    if (errCode(e) !== "EEXIST") return;
  }
  await fs.unlink(claim).catch(() => { /* 内容已在原路径（放回或新一代），残留认领名不会被当交接单读 */ });
}

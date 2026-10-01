/**
 * 一次授权此刻算不算数（lend.json v2 的 lend[]，lend-config.ts 只核形状）：暂停、缺指纹 / 到期时间、含 write、过期、期限超过 7 天，任一条都整条不生效。
 * 调度服务的每个核对点（收单、claim 前、起 worker 前、首条派单前、每次续租，lend-grant.ts liveGrant）和宿主看门狗（lend-watchdog.ts）用的都是这一个判定，
 * 不读 peers.json 的部分（指纹比对）由调用方补。纯函数，tests/lend-grant.test.ts。
 */
import type { LendEntry } from "./lend-config.js";

/**
 * 写代码的单要等硬隔离（独立 macOS 用户跑 worker，i28-W8）合并后才开：这之前授权里写了 write、手改 lend.json、旧条目迁移带过来，都整条不生效，
 * CLI 也拒。W8 合并时改这一处；改成 true 之前先确认 W8 已在出借方机器上生效。
 */
export const WRITE_ROLE_OPEN = false;

export const GRANT_MAX_DAYS = 7;
export const GRANT_MAX_MS = GRANT_MAX_DAYS * 86_400_000;
/** 授权时刻允许比本机时钟晚这么多（两次读时钟之间的抖动），再多就当手改出来的未来时间 */
const SKEW_MS = 5 * 60_000;

/** CLI（以及之后 R7a 网页）授权前必须给出借方看的那句话 */
export const SHELL_SENTENCE = "这会让发起方的任务在你的用户下随时起 shell";

export function grantProblem(e: LendEntry, now: number, writeOpen = WRITE_ROLE_OPEN): string | null {
  if (e.paused) return `已暂停：${e.paused.reason}`;
  if (!e.fp || !e.until || !e.grantedAt) return "缺对方指纹、到期时间或授权时间";
  if (!writeOpen && e.roles.includes("write")) return "含 write 角色：硬隔离（i28-W8）上线之前写代码的单一律不开，整条不生效";
  const until = Date.parse(e.until);
  const at = Date.parse(e.grantedAt);
  if (until <= now) return `已于 ${e.until} 到期`;
  if (at > now + SKEW_MS) return `授权时间 ${e.grantedAt} 在未来`;
  if (until - at > GRANT_MAX_MS || until - now > GRANT_MAX_MS) return `期限超过 ${GRANT_MAX_DAYS} 天`;
  return null;
}

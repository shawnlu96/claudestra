/**
 * 一次授权此刻算不算数（lend.json v2 的 lend[]，lend-config.ts 只核形状）：暂停、缺指纹 / 到期时间、过期、期限超过 7 天，任一条都整条不生效。
 * 调度服务的每个核对点（收单、claim 前、起 worker 前、首条派单前、每次续租，lend-grant.ts liveGrant）和宿主看门狗（lend-watchdog.ts）用的都是这一个判定，
 * 不读 peers.json 的部分（指纹比对）由调用方补。纯函数，tests/lend-grant.test.ts。
 */
import type { LendEntry } from "./lend-config.js";
import { roleOfStep } from "./lend-git.js";

/**
 * 写单收单开关（lend-inbox.ts）：生产开放，测试可注入关闭；不影响整条授权或兼容能力上报。
 * worker 和出借方仍是同一个 OS 用户；硬隔离是远期方案（docs/design/lend-isolation.md）。
 */
export const WRITE_ROLE_OPEN = true;

export const GRANT_MAX_DAYS = 7;
export const GRANT_MAX_MS = GRANT_MAX_DAYS * 86_400_000;
/** 授权时刻允许比本机时钟晚这么多（两次读时钟之间的抖动），再多就当手改出来的未来时间 */
const SKEW_MS = 5 * 60_000;

/** CLI（以及之后 R7a 网页）授权前必须给出借方看的那句话 */
export const SHELL_SENTENCE = "这会让发起方的任务在你的用户下随时起 shell";

export function grantProblem(e: LendEntry, now: number): string | null {
  if (e.paused) return `已暂停：${e.paused.reason}`;
  if (!e.fp || !e.until || !e.grantedAt) return "缺对方指纹、到期时间或授权时间";
  const until = Date.parse(e.until);
  const at = Date.parse(e.grantedAt);
  if (until <= now) return `已于 ${e.until} 到期`;
  if (at > now + SKEW_MS) return `授权时间 ${e.grantedAt} 在未来`;
  if (until - at > GRANT_MAX_MS || until - now > GRANT_MAX_MS) return `期限超过 ${GRANT_MAX_DAYS} 天`;
  return null;
}

/** 一张单的授权范围：挂单摘要里的仓库、阶段，和借的家族 */
export interface OrderScope { repo: string; step: string; family: string }

/**
 * 这张单还在授权范围里吗：仓库在白名单、阶段有效、这一族还有位。授权按 peer 一整条算有效还不够——出借方重授时可能收窄了仓库或名额，
 * 被拿掉的那部分单一样要停。claim 前、起 worker 前、续租、看门狗都核；tests/lend-revoke.test.ts「范围收窄」。
 */
export function scopeProblem(e: LendEntry, o: OrderScope): string | null {
  if (!e.repos.includes(o.repo)) return `仓库 ${o.repo} 已不在授权里`;
  if (!roleOfStep(o.step)) return `不认识的订单阶段 ${o.step}`;
  return (e.families as Record<string, number | undefined>)[o.family] ? null : `授权里已没有 ${o.family} 位`;
}

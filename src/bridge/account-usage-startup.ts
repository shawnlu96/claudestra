/**
 * 账号用量的平台无关启动项（bridge 启动段调一次，Discord 与 Web-only 都跑，不依赖 Discord ready）：
 *   - statusLine 包装批准卡服务（bridge/account-usage-statusline-consent.ts startStatuslineConsent，单例定时器）；
 *   - 上一进程被硬杀时遗留的手动探测资源：按落盘记录精确回收并记退避（lib/account-usage-refresh.ts recoverInterruptedRefresh）。
 *     硬杀时它持有的 refresh 锁也留下（5 分钟租期），启动那一刻抢不到 = busy：按间隔有界重试，锁过租期被回收后再收；
 *     绝不越过活着的持有者的锁去清它的资源（USCR1 审查 probe-shutdown）。
 * 两项都不起 TUI 探测、不碰任何用户 / agent 会话。单测 tests/account-usage-startup.test.ts。
 */
import { recoverInterruptedRefresh, type ProbeRunner } from "../lib/account-usage-refresh.js";
import { startStatuslineConsent } from "./account-usage-statusline-consent.js";
import type { Delivery, Envelope } from "./router.js";

let started = false;
/** busy 重试：每分钟一次，最多 8 次——盖过锁的 5 分钟租期 + 续租间隔，持有者真死了锁必然过期被回收 */
const RECOVER_RETRY_MS = 60_000;
const RECOVER_RETRIES = 8;

export async function startAccountUsage(
  deliver: (env: Envelope) => Promise<Delivery>,
  deps: { probe?: ProbeRunner; refreshPath?: string; consent?: Parameters<typeof startStatuslineConsent>[1]; recoverRetryMs?: number } = {},
): Promise<() => void> {
  if (started) return () => {}; // 双模式 / 重复调用都只起一次
  started = true;
  const stopConsent = startStatuslineConsent(deliver, deps.consent);
  const probe = deps.probe ?? (await import("./account-usage-probe.js")).usageProbeRunner();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const recover = async (left: number): Promise<void> => {
    const r = await recoverInterruptedRefresh({ probe, path: deps.refreshPath }).catch((e) => (console.error("📊 遗留探测清扫失败:", (e as Error).message), null));
    if (r === "recovered") console.log("📊 已回收上次中断的用量探测会话（记 30 分钟退避）");
    if (r !== "busy" || stopped) return;
    if (left <= 0) return void console.warn("📊 refresh 锁一直被占，遗留探测清扫放弃（下次手动刷新时再收）");
    retry = setTimeout(() => void recover(left - 1), deps.recoverRetryMs ?? RECOVER_RETRY_MS);
    retry.unref?.();
  };
  await recover(RECOVER_RETRIES);
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    stopConsent();
  };
}

/** 测试用 */
export function __resetAccountUsageStartupForTest(): void {
  started = false;
}

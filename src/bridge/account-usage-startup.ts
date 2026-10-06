/**
 * 账号用量的平台无关启动项（bridge 启动段调一次，Discord 与 Web-only 都跑，不依赖 Discord ready）：
 *   - statusLine 包装批准卡服务（bridge/account-usage-statusline-consent.ts startStatuslineConsent，单例定时器）；
 *   - 上一进程被硬杀时遗留的手动探测资源：按落盘记录精确回收并记退避（lib/account-usage-refresh.ts recoverInterruptedRefresh）。
 * 两项都不起 TUI 探测、不碰任何用户 / agent 会话。单测 tests/account-usage-startup.test.ts。
 */
import { recoverInterruptedRefresh, type ProbeRunner } from "../lib/account-usage-refresh.js";
import { startStatuslineConsent } from "./account-usage-statusline-consent.js";
import type { Delivery, Envelope } from "./router.js";

let started = false;

export async function startAccountUsage(
  deliver: (env: Envelope) => Promise<Delivery>,
  deps: { probe?: ProbeRunner; refreshPath?: string; consent?: Parameters<typeof startStatuslineConsent>[1] } = {},
): Promise<() => void> {
  if (started) return () => {}; // 双模式 / 重复调用都只起一次
  started = true;
  const stop = startStatuslineConsent(deliver, deps.consent);
  const probe = deps.probe ?? (await import("./account-usage-probe.js")).usageProbeRunner();
  const r = await recoverInterruptedRefresh({ probe, path: deps.refreshPath }).catch((e) => (console.error("📊 遗留探测清扫失败:", (e as Error).message), null));
  if (r === "recovered") console.log("📊 已回收上次中断的用量探测会话（记 30 分钟退避）");
  return stop;
}

/** 测试用 */
export function __resetAccountUsageStartupForTest(): void {
  started = false;
}

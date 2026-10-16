/**
 * 带族标记的存量载荷最长有效期。退出窗口至少 14 天，且不短于其中最长的一项：
 * 收兼容后一份旧族载荷还活着，持有方再拿来用就会被拒。"unknown" = 代码里没有过期时间，
 * 这类只能靠样本里的 legacyLive 实测为 0 放行（判定见 exit.ts），时间再长也不会自动当作已过期。
 */
import { INVITE_TTL_MS } from "../peers.js";
import { CAPABILITY_MAX_TTL_MS } from "../floka-compat/signature/capability.js";
import { E2E_CAPABILITY_TTL } from "../floka-compat/e2e/capability.js";
import { CENTER_CAPABILITY_TTL_MS } from "../floka-center/capability.js";
import type { PayloadKind } from "./types.js";

const DAY_MS = 86_400_000;
export const MIN_OBSERVE_MS = 14 * DAY_MS;
/** devices.ts 的 CREDENTIAL_TTL_MS（未导出）：设备 cookie 名带旧品牌，离线浏览器最晚这么久后带着它回来 */
const DEVICE_CREDENTIAL_TTL_MS = 90 * DAY_MS;

export const PAYLOAD_LIFETIMES: Readonly<Record<PayloadKind, number | "unknown">> = {
  invite: INVITE_TTL_MS,
  "signature-capability": CAPABILITY_MAX_TTL_MS,
  "e2e-capability": E2E_CAPABILITY_TTL,
  "center-capability": CENTER_CAPABILITY_TTL_MS,
  "review-ticket": "unknown",
  "lend-receipt": "unknown",
  "device-credential": DEVICE_CREDENTIAL_TTL_MS,
};

/** 零旧流量窗口的最短长度：max(14 天, 已知最长有效期)；回滚期另算（exit.ts） */
export function requiredWindowMs(): number {
  const known = Object.values(PAYLOAD_LIFETIMES).filter((v): v is number => typeof v === "number");
  return Math.max(MIN_OBSERVE_MS, ...known);
}

/**
 * 出借协议的纯类型与 literal 源（cloud-PP2）：offer 摘要、租约、模型家族、出借步骤。这里只放常量与类型，不 import 任何模块，
 * 中心与本机都能直接用；lend-wire / lend-config / lend-git 仍按原路径 re-export，git / 配置逻辑留在原处。tests/cloud-protocol-lend-boundary.test.ts。
 */

export const LEASE_MS_DEFAULT = 10 * 60_000;

export const LEND_FAMILIES = ["codex", "claude"] as const;
export type LendFamily = (typeof LEND_FAMILIES)[number];

/** 出借单的步骤：review = 审查；write = 开工单（卡在 build）；fix = 修复单（卡在 fix） */
export const LEND_STEPS = ["review", "write", "fix"] as const;
export type LendStep = (typeof LEND_STEPS)[number];

export interface OfferSummary {
  orderId: string; taskId: string; step: LendStep; family: LendFamily; repo: string; pr: number | null; head: string; round: number; specRev: number; offeredAt: number;
}
export interface LeaseState { gen: number; expiresAt: number; ms: number }

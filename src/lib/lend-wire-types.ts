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

/**
 * 角色模型档位（TIER1b）：claim 请求的可选能力位 caps（不带 = 旧对端，应答与改前逐字节相同）、A 随领单材料给的建议、B 随结果报的实际。
 * 建议只是建议：claude 单给模型 id，codex 单只给推理档（null = 照对方 Codex 自己的配置），绝不给 codex 单带模型名。
 * source：settings = owner 存过的表值，default = 默认表；实际的 suggest = 照建议起，grant = 用了出借授权里开放的一档，default = 出借方原默认。
 */
export const LEND_CLAIM_CAPS = ["suggest"] as const;
export type LendClaimCap = (typeof LEND_CLAIM_CAPS)[number];
export const SUGGEST_SOURCES = ["settings", "default"] as const;
export type ModelSuggest = { model: string; source: (typeof SUGGEST_SOURCES)[number] } | { effort: string | null; source: (typeof SUGGEST_SOURCES)[number] };
export const ACTUAL_SOURCES = ["suggest", "grant", "default"] as const;
export interface ModelActual { model: string | null; effort: string | null; source: (typeof ACTUAL_SOURCES)[number] }
/** 入账时记到卡上的那一份：对方没报（旧对端）= unknown，不拿建议充数 */
export type ModelActualRecord = ModelActual | { model: null; effort: null; source: "unknown" };

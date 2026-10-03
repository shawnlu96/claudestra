/**
 * 交付说明不全（i28-RPX1）的 wire 码：A 侧缺『复现测试：』的修复交付回 `delivery_note`（只要补文字就能过），别的 invalid 照旧。
 * 这里只放 A、B 两侧和 bridge 共用的常量，不带依赖：bridge 的拒绝码映射也引它。B 侧怎么补在 lend-delivery-amend.ts。
 */

export const DELIVERY_NOTE = "delivery_note";
/** bridge 的拒绝码 → HTTP 状态：4xx，旧版 B 照样解析出 code（落进现有 stopped 分支），不当成「结果不明」重发 */
export const DELIVERY_NOTE_STATUS = { [DELIVERY_NOTE]: 400 } as const;
/** 修复交付说明里的「复现测试：<测试名>」（A 侧 review-arbiter-deliver.ts 与 B 侧自查同一条） */
export const REPRO_NOTE_RE = /复现测试(?:名)?[:：]\s*\S+/;

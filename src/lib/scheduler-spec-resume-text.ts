/**
 * peer 卡跳过复述的两笔写（i28-W5 开卡规矩，i28-RSM1 抽出共用）：先记写明放置理由的 decision，再以「远端卡复述跳过」的复述记录把卡推到 restate。
 * start_node（dag-tools-steps.ts restateStep）与交回自动后仍在 spec 的 auto 卡（scheduler-spec-resume-write.ts）用同一份文字。
 */
export const peerRestateSkip = (why: string) => ({ decision: why, stage: { from: "spec", to: "restate", text: `远端卡复述跳过：${why}` } });

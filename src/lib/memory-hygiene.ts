/**
 * mem0 记忆卫生(v2.20+):把「定期审查记忆库」收编成产品特性。
 *
 * 单一事实源就是 cron 系统里名为 mem0-hygiene 的那条任务——本模块只提供
 * 频率预设 ↔ cron 表达式的映射和标准 prompt;设置界面(web Settings)经
 * bridge 的 /api/v1/memory-hygiene 读写,mutation 全部委托 runManager 的
 * cron-add/remove/toggle,与 CLI 手工管理完全等价、互不打架。
 *
 * owner 2026-08-26:「mem0 日积月累会变成粪坑」——原月度 cron 太稀,默认改周。
 * 审查是**只报告不动手**的(处置由 owner 决定),prompt 里这条红线不许改。
 */

export const HYGIENE_JOB_NAME = "mem0-hygiene";

export type HygieneFreq = "weekly" | "biweekly" | "monthly";

/** 预设频率 → cron 表达式(都在上午 10 点本地时间,避开夜里跑完没人看)。 */
export const HYGIENE_FREQS: Record<HygieneFreq, { schedule: string; label: string }> = {
  weekly: { schedule: "0 10 * * 1", label: "每周(周一)" },
  biweekly: { schedule: "0 10 1,15 * *", label: "半月(1/15 号)" },
  monthly: { schedule: "0 10 1 * *", label: "每月(1 号)" },
};

/** cron 表达式 → 预设名(手工改过表达式的识别成 custom,界面上原样展示不覆盖)。 */
export function freqOfSchedule(schedule: string): HygieneFreq | "custom" {
  for (const [k, v] of Object.entries(HYGIENE_FREQS)) {
    if (v.schedule === schedule.trim()) return k as HygieneFreq;
  }
  return "custom";
}

/** 标准审查 prompt(月度 cron 时代实战过的版本,措辞改成周期中性)。
 *  红线:只报告,绝不执行 memory_delete/update。 */
export function hygienePrompt(): string {
  return (
    // v2.21.4+ 分页遍历:mem0-mcp 2026-09-04 修好 memory_list(limit/offset/brief,
    // 返回 has_more)之前它永远只回 20 条,首次完整运行是绕过 MCP 直查 pgvector 才做成的。
    "对 mem0 记忆库做定期卫生检查。步骤:用 mcp__mem0__memory_list 分页遍历全库——" +
    "memory_list(limit=500, offset=N, brief=true) 逐页取,直到返回的 has_more 为 false" +
    "(brief 只带 id + 摘要,需要全文时再对单条 memory_read)。逐条审查,找出三类问题:" +
    "①明显过时(内容里的版本号/日期/状态已被更新的记忆或现实取代)" +
    "②互相矛盾(两条记忆对同一事实说法不一)" +
    "③重复冗余(同一事实多条近似表述)。" +
    "产出一份 Markdown 报告:每条问题记忆给出 id、内容摘要(50字内)、问题类型、" +
    "处置建议(保留/更新成什么/删除)。" +
    "**只报告,绝不执行任何 memory_delete/update——处置由 owner 决定**。" +
    "最后用 reply 工具把报告发出来;如果全库健康无问题,报告一句『本期记忆库无需清理』即可。"
  );
}

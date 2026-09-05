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
 * 两处例外(2026-09-06 记忆架构评估):①type=progress 且写入超过 14 天的进度快照由
 * cron 直接删(agent-mem0 转达 owner 批准)——这类条目按 owner 自己的写入纪律本就不该进
 * mem0,TTL 只是补刀;②写入护栏标记过的近重复(metadata.near_dup_of)由 cron 直接
 * 删/并(owner 2026-09-06 在 web 端勾选「允许卫生 cron 直接处置近重复」)。
 * 其余(全库过时/矛盾/冗余审查)仍旧只建议不执行。
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
    // v2.21.5+ 四步:①进度 TTL ②近重复处置(owner 09-06 放权)③全库审查(只建议;
    // 例外:superseded 打标)④检索评测。①边删边翻页会漏(Codex review):先收集完再删。
    "对 mem0 记忆库做定期卫生检查,分四步,最后用 reply 工具发一份 Markdown 报告。①②是仅有的两处授权执行 memory_delete 的步骤。" +
    "①过期进度清理:先用 mcp__mem0__memory_list(type=\"progress\", before=\"<今天减 14 天的 ISO 日期>\", brief=true, limit=500, offset=N) " +
    "分页把**全部**候选的 id 与摘要收集完(直到返回的 has_more 为 false),再逐条 mcp__mem0__memory_delete——边删边翻页会跳过后面的记录;" +
    "**只删 type=progress 的,其他类型一律不碰**;删掉的 id 与摘要列进报告。" +
    "②近重复处置(owner 2026-09-06 授权 cron 直接执行):用 memory_list(flagged=true, brief=true) 列出写入护栏标记过的近重复条目(metadata.near_dup_of)," +
    "逐对 memory_read 新旧两条全文再裁决:同一事实 → memory_update 把新条独有的信息并进旧条,然后 memory_delete 新条;新结论取代旧的 → memory_delete 旧条;" +
    "确实是两件事 → 都保留并在报告里说明。只处置带 near_dup_of 标记的这一对,拿不准的保留并列进报告;每对的裁决与动作都写进报告。" +
    "③全库审查(只建议不执行):用 memory_list(limit=500, offset=N, brief=true) 分页遍历全库,直到 has_more 为 false;找出 a)明显过时(内容里的版本号/日期/状态已被更新的记忆或现实取代)" +
    "b)互相矛盾(两条记忆对同一事实说法不一)c)重复冗余(同一事实多条近似表述);每条给 id、内容摘要(50字内)、问题类型、处置建议(保留/更新成什么/删除)。" +
    "唯一允许的动作是打标:对开场召回(recall)里高频出现但已被现实取代的条目,核实后 memory_update(id, metadata={superseded: true})——正文与向量不动,recall 不再注入,search 仍可搜到——并在报告里说明。" +
    "④检索评测:用 Bash 跑 `~/mem0-mcp/.venv/bin/python ~/mem0-mcp/eval/run_eval.py --server --json`(约 40 题 30 秒,末行是机器可读摘要)," +
    "把全局 / 项目内 / server 三列的 hit@5、hit@10 与未命中的题目写进报告,并与上一期报告对比。" +
    "**除①②的删除、②的并入与③的 superseded 打标之外,绝不执行任何 memory_delete/update——其余处置由 owner 决定**。全库健康时②③写一句『本期无需清理』即可,①④照常。"
  );
}

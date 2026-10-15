/**
 * 任务详情「现在」一句话、叫停这一轮、文件范围折叠（UXCARD1）的英文：叠在 teamBodyTr 之上，本表没有的词照旧走协作视图词表 / 全局字典。
 * 只有详情面板用，放局部词表，不改共享字典（写法同 work/work-i18n.ts、team-body/team-body-i18n.ts）。
 */
import { fillParams } from "@/lib/i18n-fill";
import type { Lang } from "@/lib/i18n";
import type { Tr } from "./collab-model";

const EN: Record<string, string> = {
  "{who} 在写": "{who} is writing",
  "{who} 在审第 {n} 轮": "{who} is reviewing round {n}",
  "{who} 在审": "{who} is reviewing",
  "{who} 在改第 {n} 轮意见": "{who} is fixing round {n} feedback",
  "{who} 在改审查意见": "{who} is fixing review feedback",
  "等 {who} 放行": "Waiting for {who} to approve",
  "等 {who} 验证": "Waiting for {who} to verify",
  "还没开工，等 {who} 派发": "Not started, waiting for {who} to dispatch",
  "等审查员领单": "Waiting for a reviewer to claim",
  "等合并": "Awaiting merge",
  "受阻": "Blocked",
  "已 {d}": "{d} so far",
  "已等 {d}": "waiting {d}",
  "在 {m}": "on {m}",
  "执行者": "Worker",
  "审查员": "Reviewer",
  "下一步：PM 派发": "Next: PM dispatches",
  "下一步：PM 放行后执行者开写": "Next: PM approves, then the worker starts",
  "下一步：执行者送审": "Next: worker sends it to review",
  "下一步：审查员给结论（通过进合并，不通过回执行者）": "Next: reviewer decides (pass → merge, otherwise back to the worker)",
  "下一步：执行者改完再送审": "Next: worker fixes and sends it back to review",
  "下一步：合并后上线": "Next: merge, then go live",
  "下一步：PM 验证": "Next: PM verifies",
  "下一步：PM 解除阻塞": "Next: PM unblocks it",
  "叫停这一轮": "Stop this turn",
  "确认叫停": "Confirm stop",
  "正在叫停…": "Stopping…",
  "已叫停": "Stopped",
  "叫停失败": "Stop failed",
  "只打断执行者当前这一轮，卡不退回、调度照常；5 秒内再点一次才发出": "Only interrupts the worker's current turn; the card is not sent back and scheduling continues. Click again within 5 seconds to send",
  "文件范围 · {n} 个": "File scope · {n}",
  "{m} 上的 {f}": "{f} on {m}",
  "{m} 上的执行者": "Worker on {m}",
  "{who} 在复述": "{who} is restating",
  "{who} 在交付": "{who} is publishing",
  "已合并，在部署": "Merged, deploying",
  "正在合并": "Merging now",
  "老卡（没有调度记录）· 停在{s}，调度器不派活": "Legacy card (no scheduler record) · stuck at {s}; the scheduler won't dispatch it",
  "下一步：PM 接手": "Next: PM takes over",
  "下一步：PM 收尾或补调度记录": "Next: PM closes it out or adds a scheduler record",
  "数据可能过期（本机详情最后读到 {t}）": "Data may be stale (local detail last read at {t})",
  "执行者在伙伴机器上，从这里发不到": "The worker is on a partner machine; messages can't be sent from here",
  "本机详情暂时读不到，恢复后可用": "Local detail is unavailable right now; available once it recovers",
  "这张卡在 {m} 上执行，对它说要那台机器授权，暂不支持": "This card runs on {m}; talking to it needs that machine's authorization, not supported yet",
};

export function detailNowTr(tr: Tr, lang: Lang): Tr {
  return (s, p) => (lang !== "zh" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : tr(s, p));
}

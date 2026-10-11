import type { PmRouteClass } from "./pm-route-types.js";

export interface PmAuditItem { n: number; target: string; suggestion: string; detail: string; raw: string; declared?: string }
interface RuleBase { id: string; route: PmRouteClass; reason: string }
interface TrainRule extends RuleBase { wire: "train"; match: RegExp; digest?: boolean }
interface AuditRule extends RuleBase { wire: "audit"; type: string; match(item: PmAuditItem): boolean }
const IDS = "(?:[A-Za-z0-9_-]+(?:、[A-Za-z0-9_-]+)*|（无）)";
const TOKEN = "[A-Za-z0-9_.:-]+";
const QUEUE = `排队中：列车在合 ${TOKEN}，(?:testing|settling|cleanup|done)`;
const ship = new RegExp(`^(${TOKEN}) 在 merge 已 \\d+ 分钟没推进（${QUEUE}）$`);
const ready = new RegExp(`^(${TOKEN}) 在 merge，审查 #\\d+ 已 PASS(?:（经 \\d+ 次正式沿用）)?、当前 head [a-f0-9]{12} CI 全绿，`
  + `已 \\d+ 分钟没动；实际阻塞：${QUEUE}；mainCarry=(?:off|observe|on)$`);
const orphan = new RegExp(`^(${TOKEN}) 属于本项目，台账里没有它的任务（(出借在途：${TOKEN} 单 ${TOKEN}，`
  + `(?:等领单|对方最近活动 \\d+ 分钟前)|复述会话：${TOKEN} (?:出借在途|已 (?:verified|done|cancelled)))）$`);

/** 批准规则集中一表；整段 wire 匹配，所有调用方先核实来源和保护项。 */
const RULES: readonly (TrainRule | AuditRule)[] = [
  { wire: "train", id: "train.form", route: "auto", reason: "受信列车已组车",
    match: new RegExp(`^组车 [1-9]\\d* 张：${IDS}，起点 main [a-f0-9]{8}$`) },
  { wire: "train", id: "train.done", route: "auto", reason: "受信列车已结束",
    match: new RegExp(`^结束（(?:merged|void|serial)）：合并 ${IDS}，退回 ${IDS}，串行 ${IDS}，CI \\d+ 次$`) },
  { wire: "train", id: "train.void-red", route: "auto", reason: "组合红已自动二分或退回重组",
    match: new RegExp(`^作废：组合红，(?:已由代码二分(?:退回)?|已退回)；已合并 ${IDS}，其余回去重新组车$`) },
  { wire: "train", id: "train.hold", route: "digest", reason: "受信列车常规让路", digest: true,
    match: /^[A-Za-z0-9_-]+ 等第 \d+ 辆列车 [a-z0-9]+-[a-z0-9]+ 结束（(?:拼车 \/ 跑 CI|逐张合并)）再申请合并槽，不 update-branch、不合并$/ },
  { wire: "train", id: "train.bisect", route: "digest", reason: "列车自动二分进度", digest: true,
    match: new RegExp(`^第 [1-9]\\d* 层二分：\\[${IDS}\\] / \\[${IDS}\\]$`) },
  { wire: "train", id: "train.ci-red", route: "digest", reason: "车厢 CI 红由列车二分处理", digest: true,
    match: new RegExp(`^车厢 [a-z0-9]+-[a-z0-9]+[ab]*（${IDS}）CI 红：[^\\n；]+；[^\\n]*$`) },
  { wire: "audit", route: "auto", id: "audit.ship-queued", type: "ship_stalled", reason: "合并停滞是列车排队事实",
    match: (i) => i.suggestion === "补做合并部署，做完推阶段" && ship.exec(i.detail)?.[1] === i.target },
  { wire: "audit", route: "auto", id: "audit.ready-queued", type: "merge_ready_idle", reason: "合并就绪仅被列车排队阻塞",
    match: (i) => i.suggestion === "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled" && ready.exec(i.detail)?.[1] === i.target },
  { wire: "audit", route: "auto", id: "audit.orphan-lent", type: "orphan_executor", reason: "孤儿条目注明出借在途",
    match: (i) => i.suggestion === "补建任务或回收执行者" && !!orphan.exec(i.detail)?.[2]?.startsWith("出借在途：") },
  { wire: "audit", route: "auto", id: "audit.orphan-relay", type: "orphan_executor", reason: "孤儿条目注明复述会话",
    match: (i) => i.suggestion === "补建任务或回收执行者" && !!orphan.exec(i.detail)?.[2]?.startsWith("复述会话：") },
];

export function matchPmTrainRule(payload: string): TrainRule | undefined {
  const found = RULES.find((r): r is TrainRule => r.wire === "train" && r.match.test(payload));
  if (found?.id === "train.form") {
    const form = /^组车 (\d+) 张：(.+)，起点 main/.exec(payload);
    if (!form || Number(form[1]) < 2 || form[2]!.split("、").length !== Number(form[1]) || form[2] === "（无）") return;
  }
  return found;
}

export function matchPmAuditRule(item: PmAuditItem): AuditRule | undefined {
  return RULES.find((r): r is AuditRule => r.wire === "audit" && (!item.declared || item.declared === r.type) && r.match(item));
}

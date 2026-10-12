import type { PmRouteClass } from "./pm-route-types.js";

export interface PmAuditItem { n: number; target: string; suggestion: string; detail: string; raw: string; declared?: string }
interface RuleBase { id: string; route: PmRouteClass; reason: string }
interface TrainRule extends RuleBase { wire: "train"; match: RegExp; digest?: boolean }
interface AuditRule extends RuleBase { wire: "audit"; type: string; match(item: PmAuditItem): boolean }
/** 调度器整条正文就是一行的受信摘要（PMAUTO1）：没有列车前缀，整条按完整模板认。 */
/** match 带 d 标志，捕获组 = 结构化字段（卡号、编号、路径、目标键）：保护项只看模板的固定文字，见 pmLineFixedText。 */
interface LineRule extends RuleBase { wire: "line"; match: RegExp; digest: true }
const IDS = "(?:[A-Za-z0-9_-]+(?:、[A-Za-z0-9_-]+)*|（无）)";
const TOKEN = "[A-Za-z0-9_.:-]+";
const QUEUE = `排队中：列车在合 ${TOKEN}，(?:ready|updating|await_review|await_ci|merging)`;
const ship = new RegExp(`^(${TOKEN}) 在 merge 已 \\d+ 分钟没推进（${QUEUE}）$`);
const READY_HEAD = `^(${TOKEN}) 在 merge，审查 #\\d+ 已 PASS(?:（经 \\d+ 次正式沿用）)?、当前 head [a-f0-9]{12} CI 全绿，`
  + `已 \\d+ 分钟没动；实际阻塞：`;
const ready = new RegExp(`${READY_HEAD}${QUEUE}；mainCarry=(?:off|observe|on)$`);
const readyItem = new RegExp(`${READY_HEAD}[^\\n]+；mainCarry=(?:off|observe|on)$`);
const orphan = new RegExp(`^(${TOKEN}) 属于本项目，台账里没有它的任务（(出借在途：${TOKEN} 单 ${TOKEN}，`
  + `(?:等领单|对方最近活动 \\d+ 分钟前)|复述会话：${TOKEN} (?:出借在途|已 (?:verified|done|cancelled)))）$`);

const FIDS = "[\\w.-]{1,80}(?:、[\\w.-]{1,80})*";
const P2_IN = `P2 (${FIDS}) 已入积压 (\\S+)`, P2_LINK = `降级 (${FIDS}) 关联跟进 #\\d+`;

/** 批准规则集中一表；整段 wire 匹配，所有调用方先核实来源和保护项。 */
const RULES: readonly (TrainRule | AuditRule | LineRule)[] = [
  { wire: "line", id: "p2.backlog", route: "digest", reason: "普通 P2 已持久入积压", digest: true,
    match: new RegExp(`^\\[P2 积压\\] (${TOKEN}) 第 [1-9]\\d* 轮：(?:${P2_IN}(?:；${P2_LINK})?|${P2_LINK})$`, "d") },
  { wire: "line", id: "observation.promoted", route: "digest", reason: "登记的观察期核对通过，已自动转正", digest: true,
    match: new RegExp(`^\\[观察期转正\\] (${TOKEN}) (?:recovery|autostart):([A-Za-z]\\w{0,40}) observe→on（登记 obs-[1-9]\\d*，卡上 note #\\d+）$`, "d") },
  { wire: "train", id: "train.form", route: "auto", reason: "受信列车已组车",
    match: new RegExp(`^组车 [1-9]\\d* 张：${IDS}，起点 main [a-f0-9]{12}$`) },
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

export const matchPmLineRule = (body: string): LineRule | undefined => RULES.find((r): r is LineRule => r.wire === "line" && r.match.test(body));

/**
 * 一行摘要去掉结构化字段后剩下的固定文字。字段的字符集已被完整模板卡死（不含空白、标点问句），是调度器自己填的编号 / 路径，
 * 不是要 PM 回应的正文；编号叫 typo-failure、目录叫 P0 不该把已归好类的摘要打回 judge。模板以外多出的字照旧不匹配规则、整段受保护。
 */
export function pmLineFixedText(rule: LineRule, body: string): string {
  const spans = (rule.match.exec(body)?.indices ?? []).slice(1).filter((x): x is [number, number] => !!x).sort((a, b) => b[0] - a[0]);
  return spans.reduce((text, [from, to]) => text.slice(0, from) + text.slice(to), body);
}

export function matchPmAuditRule(item: PmAuditItem): AuditRule | undefined {
  return RULES.find((r): r is AuditRule => r.wire === "audit" && (!item.declared || item.declared === r.type) && r.match(item));
}

/** 固定的字段名不是动作请求；只在类型、目标和完整 ready 模板吻合时识别它，实际阻塞正文仍要保护。 */
export function isPmReadyAuditItem(item: PmAuditItem): boolean {
  return (!item.declared || item.declared === "merge_ready_idle") && readyItem.exec(item.detail)?.[1] === item.target;
}

/**
 * 人工卡交付后的接手提醒（RVF-2，docs/architecture/manual-deliver-notice.md）：判定与文案是纯函数，投递在 bridge/manual-deliver-notice.ts。
 * 非 auto 卡交付后没有调度器接手：① 交付即通知卡的 PM（班子路由已直推 PM 的不重复）；② N 分钟没有 dispatch / review → PM【升级】；
 * ③ 再过 M 分钟仍没有 → owner「待你处理」。之后一有 dispatch / review、或卡不再等审，升级撤销。
 * 巡检 manual_deliver_no_review 用同一份阈值（mdnAudit.config）和同一份去重状态（mdnAudit.pushedAt），同一次交付只推 PM 一次。
 */
import { pmOf } from "./ledger-handler.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import type { TeamConfig } from "./ledger-team-config.js";
import { statePath } from "./paths.js";
import { quoteExternal, refLike, shaLike } from "./quote-text.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const MIN = 60_000;
/** owner 改阈值：{ "pmAfterMin": 1..1440, "ownerAfterMin": 1..1440 }；没有文件 = 缺省 */
export const MDN_CONFIG_PATH = statePath("manual-deliver-notice.json");
export const MDN_STATE_PATH = statePath("manual-deliver-notice-state.json");
const MDN_DEFAULTS: MdnConfig = { pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN };
/** 已撤销的记录留这么久再删：卡退出等审又回来（blocked → fix，没有新交付）时不重推同一次交付 */
const RESOLVED_KEEP_MS = 7 * 24 * 60 * MIN;
const AWAITS_REVIEW: readonly Stage[] = ["build", "review", "fix"];

export interface MdnConfig {
  /** 交付后多久没有派审 / 审查就升级 PM（N） */
  pmAfterMs: number;
  /** 升级 PM 之后再过多久进 owner（M） */
  ownerAfterMs: number;
}

const minutes = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1440 ? (v as number) * MIN : null);

/** 读不了 / 写错 = 缺省值 + error（调用方打日志），不让一个错字把提醒关掉 */
export function readMdnConfig(path = MDN_CONFIG_PATH): { config: MdnConfig; error?: string } {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { config: MDN_DEFAULTS };
  if (r.status === "corrupt") return { config: MDN_DEFAULTS, error: `${path} 读不了：${r.error}` };
  const d = (r.data ?? {}) as Record<string, unknown>;
  const pm = d.pmAfterMin === undefined ? MDN_DEFAULTS.pmAfterMs : minutes(d.pmAfterMin);
  const owner = d.ownerAfterMin === undefined ? MDN_DEFAULTS.ownerAfterMs : minutes(d.ownerAfterMin);
  if (pm === null || owner === null) return { config: MDN_DEFAULTS, error: `${path}：pmAfterMin / ownerAfterMin 要是 1..1440 的整数，按缺省` };
  return { config: { pmAfterMs: pm, ownerAfterMs: owner } };
}

/** 一次交付一条记录；key = 项目|卡|交付 seq */
export interface MdnRecord {
  deliverTs: number;
  notified?: number;
  pm?: number;
  owner?: number;
  askId?: string;
  resolvedAt?: number;
}
export type MdnState = Record<string, MdnRecord>;

export const mdnKey = (project: string, taskId: string, seq: number): string => `${project}|${taskId}|${seq}`;
/** 巡检那条发现的 key（ledger-audit.ts keyOf 同一拼法）：bridge 据此认「巡检已经推过 PM」 */
export const mdnAuditKey = (project: string, taskId: string, seq: number): string => `${project}|manual_deliver_no_review|${taskId}|${seq}`;

const validState = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d);

/** 坏文件按空读（会重推一次，不会漏推），error 交调用方打日志 */
export function readMdnState(path = MDN_STATE_PATH): { state: MdnState; missing: boolean; error?: string } {
  const r = readJsonStateSync(path, validState);
  if (r.status === "ok") return { state: r.data as MdnState, missing: false };
  return { state: {}, missing: r.status === "missing", ...(r.status === "corrupt" ? { error: r.error } : {}) };
}

export function writeMdnState(state: MdnState, now: number, path = MDN_STATE_PATH): void {
  const kept = Object.entries(state).filter(([, r]) => r.resolvedAt === undefined || now - r.resolvedAt < RESOLVED_KEEP_MS);
  writeJsonAtomicSync(path, Object.fromEntries(kept));
}

/** 正在等派审的那次交付：非 auto、在 build / review / fix、最后一次交付之后（按 seq）没有 dispatch / review；否则 null */
export function pendingDelivery(task: Pick<LedgerTask, "stage">, events: readonly LedgerEvent[], workflowMode: string | null): LedgerEvent | null {
  if (workflowMode === "auto" || !AWAITS_REVIEW.includes(task.stage)) return null;
  const d = events.findLast((e) => e.kind === "deliver");
  if (!d || events.some((e) => (e.kind === "dispatch" || e.kind === "review") && e.seq > d.seq)) return null;
  return d;
}

export interface MdnTeam {
  pms: readonly string[];
  team: TeamConfig | null;
}

/** 卡的 PM（任务上记的优先，其次名单里第一个不是调度助理的）；名单里只有调度助理（PM 兼调度助理）时就是它 */
export const mdnPm = (task: Pick<LedgerTask, "pm">, t: MdnTeam): string | null =>
  pmOf(task, { pms: t.pms, dispatcher: t.team?.dispatcher ?? null }) ?? t.pms[0] ?? null;

/**
 * 「交付即通知」发给谁；null = 不发：没有 PM、PM 自己交付的、或班子路由（lib/team-route.ts）已经把这条交付直推给了 PM
 * （开了班子、事件在开班子之后，且没配调度助理或调度助理就是 PM）。没开班子的项目班子路由不发，这里补上。
 */
export function immediateTarget(task: Pick<LedgerTask, "pm">, d: LedgerEvent, t: MdnTeam): string | null {
  const pm = mdnPm(task, t);
  if (!pm || pm === d.actor) return null;
  const routed = !!t.team && d.seq > t.team.sinceSeq;
  return routed && (!t.team!.dispatcher || t.team!.dispatcher === pm) ? null : pm;
}

export type MdnAction = "notify" | "notify-late" | "pm" | "owner";

/**
 * 这次交付下一步该做什么；null = 现在不用做。按顺序一步一步走（调用方做完一步更新记录再问）：
 * 还没通知过 → N 分钟内 notify，超过了（bridge 停过）notify-late 只记不发、直接看升级；N 分钟到 → pm；升级 PM 之后满 M 分钟 → owner。
 */
export function nextAction(rec: MdnRecord, now: number, cfg: MdnConfig): MdnAction | null {
  if (rec.notified === undefined) return now - rec.deliverTs < cfg.pmAfterMs ? "notify" : "notify-late";
  if (rec.pm === undefined) return now - rec.deliverTs >= cfg.pmAfterMs ? "pm" : null;
  if (rec.owner === undefined) return now - rec.pm >= cfg.ownerAfterMs ? "owner" : null;
  return null;
}

const tid = (id: string): string => (refLike(id) ? id : quoteExternal(id, 40));
const short = (sha: unknown): string => (typeof sha === "string" && shaLike(sha) ? sha.slice(0, 10) : "?");
const pad = (n: number) => String(n).padStart(2, "0");
const mdnClock = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mins = (ms: number) => `${Math.max(0, Math.floor(ms / MIN))} 分钟`;
const round = (d: LedgerEvent): number => (typeof d.data.round === "number" ? d.data.round : 0);
const dispatchLine = (cmd: string, task: Pick<LedgerTask, "id">) =>
  `下一步：${cmd} ledger dispatch ${tid(task.id)}\n→ 用 Agent 工具按输出的 description / prompt 派审查员；结论存进输出里的 reviewPath，再跑 ledger review。`;

/** 文案只由代码拼：卡号、轮次、head、actor（身份推导）、时刻；交付说明等自由文本不进来 */
export function noticeText(task: Pick<LedgerTask, "id">, d: LedgerEvent, workflowMode: string | null, cfg: MdnConfig, cmd: string): string {
  return [
    `[台账·人工卡] ${tid(task.id)} 第 ${round(d)} 轮交付 @${short(d.data.headSHA)}（${d.actor}，workflow ${workflowMode ?? "无"}）：调度器不接手，等你派审。`,
    dispatchLine(cmd, task),
    `（${mins(cfg.pmAfterMs)}内没有派审 / 审查记录会升级提醒，再过 ${mins(cfg.ownerAfterMs)}进 owner「待你处理」）`,
  ].join("\n");
}

export function escalateText(task: Pick<LedgerTask, "id">, d: LedgerEvent, now: number, cfg: MdnConfig, cmd: string): string {
  return [
    `【升级】人工卡 ${tid(task.id)} 第 ${round(d)} 轮 ${mdnClock(d.ts)} 交付，已 ${mins(now - d.ts)}没有派审 / 审查记录。`,
    dispatchLine(cmd, task),
    `再过 ${mins(cfg.ownerAfterMs)}仍没有，进 owner「待你处理」。`,
  ].join("\n");
}

export function ownerCardText(task: Pick<LedgerTask, "id" | "project">, d: LedgerEvent, pm: string | null, rec: MdnRecord, now: number, cmd: string):
  { title: string; context: string } {
  return {
    title: `人工卡 ${tid(task.id)} 交付后没人派审`,
    context: [
      `卡 ${tid(task.id)}（项目 ${tid(task.project)}）第 ${round(d)} 轮 ${mdnClock(d.ts)} 交付，已 ${mins(now - d.ts)}没有派审 / 审查记录。`,
      `该谁派审：PM ${pm ?? "（项目没有 PM）"}；${rec.pm !== undefined ? `${mdnClock(rec.pm)} 已给 PM 发过升级。` : ""}`,
      `派审命令：${cmd} ledger dispatch ${tid(task.id)}`,
      "派审或记了审查之后这张卡自动撤销。",
    ].join("\n"),
  };
}

/** 巡检（ledger-audit.ts manualDeliver）读阈值和去重状态的口子；单测换掉，不给 = 读同一份配置 / 状态文件 */
export interface MdnAuditPort {
  config(): MdnConfig;
  /** 这次交付已经给 PM 推过（交付后的升级）的时刻；没有 = null */
  pushedAt(key: string): number | null;
}
const filePort: MdnAuditPort = {
  config: () => readMdnConfig().config,
  pushedAt: (key) => readMdnState().state[key]?.pm ?? null,
};
export let mdnAudit: MdnAuditPort = filePort;
export function setMdnAuditPort(p?: Partial<MdnAuditPort>): void {
  mdnAudit = { ...filePort, ...p };
}

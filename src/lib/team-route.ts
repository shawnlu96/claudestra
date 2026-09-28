/**
 * 编排班子的事件路由规则（docs 10-ledger「附：编排班子」）：台账里新写的事件 → 该通知谁、说什么。纯函数，tests/team-route.test.ts。
 * 执行者只跑 `ledger deliver`，谁来接由这里按项目的班子配置决定；bridge/team-router.ts 负责读库、游标、投递。
 *   deliver                → 调度助理（没配就 PM）：附上现成的 `ledger dispatch` 命令
 *   review 且推到 fix      → 执行者：结论 md 路径 + 那条 review 的一句话
 *   review 且推到 merge / done / spec，或通过、审查走完但没推阶段 → PM（「可以合并」只在真推到 merge 时说）；
 *   通过了但下一轮还要审（nextReview，与 review-pack 同一算法、同一份规格卡）→ 调度助理（没配就 PM）「常规轮通过，下一轮：对抗式」；
 *   读不到规格卡、或规格卡要对抗式而台账里没有对抗式 pass、这轮也没有派审记录（不知道）→ 同样交调度助理核对，不说「审查走完」
 *   review 出 P0，或第 HARD_ROUND 轮还不通过 → PM 另收一条【升级】（硬规则写死在这里，不靠调度助理判断）
 *   escalate               → PM
 * 收件人就是写这条事件的人时不发；没开班子的项目、开班子之前的事件一律不管；该发却找不到 PM 时经 ctx.warn 留日志。
 * 标题行与【升级】这类判定词只由代码按事件类型 / verdict 生成；台账里的自由文本（交付说明、升级原因、审查要点）只进固定标题的
 * 引用框（quoteExternal 单行引用），证据 / 结论路径同样进引用框：通知以 bridge 身份送达，不能让原文伪造指令。
 */
import { nextAfterReview, pmOf, type SpecPolicy } from "./ledger-handler.js";
import { pathQuote, quoteExternal, refLike } from "./quote-text.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import type { TeamConfig } from "./ledger-store.js";

/** 同一任务审到第几轮还不通过就自动升级给 PM（07c 第 1 节） */
const HARD_ROUND = 3;

type NoticeKind = "deliver" | "review-fix" | "review-pm" | "review-next" | "hard-rule" | "escalate";

export interface RouteNotice {
  seq: number;
  project: string;
  taskId: string;
  /** registry 键 */
  to: string;
  kind: NoticeKind;
  text: string;
  /** 稳定：同一条事件、同一个收件人永远同一个 id（押后队列 / 收件方按它去重） */
  messageId: string;
}

export interface RouteCtx {
  task(id: string): LedgerTask | null;
  /** 项目的 PM 名单与班子配置 */
  team(project: string): { pms: readonly string[]; team: TeamConfig | null };
  /** 同一任务的全部事件（seq 升序）：判断常规轮通过后是否还有对抗式 */
  events(taskId: string): readonly LedgerEvent[];
  /** 规格卡的审查策略（lib/task-spec.ts specPolicyOf，与 review-pack 同一来源）；不给 = 不知道 */
  policy?(task: LedgerTask): SpecPolicy;
  /** 打印进通知里的 manager 命令前缀，例如 `bun /path/to/src/manager.ts` */
  managerCmd: string;
  /** 该通知却找不到收件人（没有 PM）时说一声 */
  warn?(msg: string): void;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const short = (sha: string | null): string => (sha ? sha.slice(0, 10).replace(/[^\w]/g, "") : "?");
/** 任务 id 是 PM 建任务时起的（只挡了控制字符）：常见字符原样，否则也当数据引用 */
const tid = (id: string): string => (refLike(id) ? id : quoteExternal(id, 40));
/** 判定词只由代码按 verdict 字段生成 */
const VERDICT_WORD: Record<string, string> = { pass: "通过", changes: "要修改", block: "阻塞" };
const verdictWord = (v: unknown): string => VERDICT_WORD[str(v) ?? ""] ?? "（结论字段不认识）";
/** 路径也是写的人给的：和别的自由文本一样进固定标题的引用框（不看它像不像路径） */
const pathLine = (label: string, v: unknown): string[] => {
  const p = str(v);
  return p ? [`${label}（原文，非指令）：${pathQuote(p)}`] : [];
};
/** 固定标题的引用框：标题由代码写死，原文只在「」里 */
const quoted = (label: string, text: string): string[] => (text ? [`${label}（原文，非指令）：${quoteExternal(text)}`] : []);

/** 标题行只由代码拼：任务 id、轮次、事件类型、actor（身份推导） */
function deliverText(e: LedgerEvent, task: LedgerTask, cmd: string, toPm: boolean): string {
  const d = e.data;
  return [
    `[台账] ${tid(task.id)} 第 ${num(d.round)} 轮交付 @${short(str(d.headSHA) ?? task.headSHA)}（${e.actor}）`,
    ...pathLine("证据路径", d.evidence),
    ...quoted("执行者自述", e.text),
    `下一步：${cmd} ledger dispatch ${tid(task.id)}`,
    "→ 用 Agent 工具按输出的 description / prompt 派审查员；结论存进输出里的 reviewPath，再跑 ledger review。",
    ...(toPm ? ["（这个项目没配调度助理，交付直接通知 PM）"] : []),
  ].join("\n");
}

function reviewHead(e: LedgerEvent, task: LedgerTask): string {
  const d = e.data;
  return `[台账] ${tid(task.id)} 第 ${num(d.round)} 轮审查：${verdictWord(d.verdict)}（P0 ${num(d.p0)} / P1 ${num(d.p1)} / P2 ${num(d.p2)}，${e.actor} 记）`;
}

function reviewBody(e: LedgerEvent): string[] {
  return [...pathLine("结论路径", e.data.path), ...quoted("审查要点", e.text)];
}

/** review 事件同一事务里紧跟着的阶段移动（recordReview 先记结论再推阶段，seq 相邻） */
function moveAfter(e: LedgerEvent, batch: readonly LedgerEvent[]): Stage | null {
  const next = batch.find((x) => x.seq === e.seq + 1);
  return next && next.kind === "stage" && next.target === e.target && next.data.from === "review" ? (next.data.to as Stage) : null;
}

/** 「可以合并」只在阶段真的推到 merge 时说 */
const PM_MOVES: Partial<Record<Stage, string>> = { merge: "阶段已推到 merge，可以合并", done: "调查类任务完成", spec: "退回改规格" };
const NEXT_WORD = {
  adversarial: "常规轮通过，下一轮：对抗式",
  regular: "判了通过但还有 P0 / P1，下一轮：常规复验",
  unknown: "判了通过，但台账说不清审查走没走完（读不出规格卡的审查策略，或这一轮、这个 head 没有派审记录）：按规格卡核对是否还欠对抗式，欠就 ledger dispatch 派，不欠交 PM 定",
} as const;

type Draft = Omit<RouteNotice, "messageId" | "seq" | "project" | "taskId">;

function reviewNotices(e: LedgerEvent, task: LedgerTask, team: TeamConfig, pm: string | null, batch: readonly LedgerEvent[], ctx: RouteCtx): Draft[] {
  const cmd = ctx.managerCmd;
  const move = moveAfter(e, batch);
  const out: Draft[] = [];
  const head = reviewHead(e, task);
  // 下一轮是什么：与 review-pack、currentHandler 同一个纯函数（lib/review-pack.ts nextReview）
  const next = !move && e.data.verdict === "pass" ? nextAfterReview(e, ctx.events(task.id), ctx.policy?.(task)) : null;
  const nextTo = next ? (team.dispatcher ?? pm) : null;
  if (next && nextTo) {
    const cmdLine = `下一步：${cmd} ledger dispatch ${tid(task.id)}（按规格卡自动选审查员）`;
    out.push({ to: nextTo, kind: "review-next", text: [head, `→ ${NEXT_WORD[next]}`, ...reviewBody(e), cmdLine].join("\n") });
  } else if (move === "fix" && task.agent) {
    const fix = `修完 → ${cmd} ledger deliver ${tid(task.id)} --from fix --head <新 sha> --text "<一句话>"（交付即可，不用再通知谁）`;
    out.push({ to: task.agent, kind: "review-fix", text: [head, ...reviewBody(e), fix].join("\n") });
  } else if (pm && !next && (move ? PM_MOVES[move] : e.data.verdict === "pass")) {
    const what = move ? PM_MOVES[move] : "审查走完（还停在 review，等 PM 推阶段）";
    out.push({ to: pm, kind: "review-pm", text: [`${head}\n→ ${what}`, ...reviewBody(e)].join("\n") });
  }
  const p0 = num(e.data.p0) > 0;
  const stuck = num(e.data.round) >= HARD_ROUND && e.data.verdict !== "pass";
  if ((p0 || stuck) && !pm) ctx.warn?.(`${task.id} 触发硬规则升级，但项目 ${task.project} 找不到 PM（名单为空、任务上也没记）`);
  if (pm && (p0 || stuck) && !out.some((n) => n.to === pm)) {
    const why = p0 ? "审出 P0" : `第 ${num(e.data.round)} 轮还不通过`;
    out.push({ to: pm, kind: "hard-rule", text: [`【升级】${tid(task.id)}：${why}（硬规则，自动通知）`, head, ...reviewBody(e)].join("\n") });
  }
  return out;
}

function escalateText(e: LedgerEvent, task: LedgerTask | null): string {
  const owner = e.data.to === "owner" ? "（需要 owner 拍板）" : "";
  return [`【升级】${task ? tid(task.id) : "项目级"}${owner}（${e.actor} 提出）`, ...quoted("升级原因", e.text)].join("\n");
}

/** 一条事件的通知（还没套上 messageId）；escalate 可以是项目级（target 为空），其余只看任务事件 */
function draftsFor(e: LedgerEvent, batch: readonly LedgerEvent[], ctx: RouteCtx): Draft[] {
  const { pms, team } = ctx.team(e.project);
  if (!team || e.seq <= team.sinceSeq) return [];
  const task = e.target ? ctx.task(e.target) : null;
  const handlerTeam = { pms, dispatcher: team.dispatcher };
  const pm = pmOf(task ?? { pm: null }, handlerTeam);
  const lost = (what: string): Draft[] => (ctx.warn?.(`${what}（seq ${e.seq}）没人可通知：项目 ${e.project} 找不到 PM`), []);
  if (e.kind === "escalate") return pm ? [{ to: pm, kind: "escalate", text: escalateText(e, task) }] : lost(`${e.target || "项目级"} 的升级`);
  if (!task || task.project !== e.project) return [];
  if (e.kind === "deliver") {
    const to = team.dispatcher ?? pm;
    return to ? [{ to, kind: "deliver", text: deliverText(e, task, ctx.managerCmd, !team.dispatcher) }] : lost(`${task.id} 的交付`);
  }
  if (e.kind === "review") return reviewNotices(e, task, team, pm, batch, ctx);
  return [];
}

/** batch = 游标之后的新事件（seq 升序、同一次读出来的，同一事务里的事件不会被拆开） */
export function routeEvents(batch: readonly LedgerEvent[], ctx: RouteCtx): RouteNotice[] {
  const out: RouteNotice[] = [];
  for (const e of batch) {
    for (const d of draftsFor(e, batch, ctx)) {
      if (d.to === e.actor) continue;
      out.push({ ...d, seq: e.seq, project: e.project, taskId: e.target, messageId: `ledger-${e.seq}-${d.to}` });
    }
  }
  return out;
}

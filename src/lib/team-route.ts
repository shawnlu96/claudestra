/**
 * 编排班子的事件路由规则（docs 10-ledger「附：编排班子」）：台账里新写的事件 → 该通知谁、说什么。纯函数，tests/team-route.test.ts。
 * 执行者只跑 `ledger deliver`，谁来接由这里按项目的班子配置决定；bridge/team-router.ts 负责读库、游标、投递。
 *   deliver                → 调度助理（没配就 PM）：附上现成的 `ledger dispatch` 命令
 *   review 且推到 fix      → 执行者：结论 md 路径 + 那条 review 的一句话
 *   review 且推到 merge / done / spec，或通过但没推阶段 → PM；常规轮通过而还要对抗式最后一轮 → 调度助理（没配就 PM）接着派
 *   review 出 P0，或第 HARD_ROUND 轮还不通过 → PM 另收一条【升级】（硬规则写死在这里，不靠调度助理判断）
 *   escalate               → PM
 * 收件人就是写这条事件的人时不发；没开班子的项目、开班子之前的事件一律不管；该发却找不到 PM 时经 ctx.warn 留日志。
 * 别人写的文本（交付说明、升级原因、审查要点）一律经 quoteExternal 压成单行引用，证据只认路径：通知以 bridge 身份送达，不能让原文伪造指令。
 */
import { adversarialPending, pmOf } from "./ledger-handler.js";
import { pathLike, quoteExternal } from "./quote-text.js";
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
  /** 打印进通知里的 manager 命令前缀，例如 `bun /path/to/src/manager.ts` */
  managerCmd: string;
  /** 该通知却找不到收件人（没有 PM）时说一声 */
  warn?(msg: string): void;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const short = (sha: string | null): string => (sha ? sha.slice(0, 10).replace(/[^\w]/g, "") : "?");
/** 任务名：PM 起的，也压成单行 */
const title = (t: LedgerTask): string => `${t.id}${quoteExternal(t.title, 80)}`;
const evidenceLine = (v: unknown): string[] => {
  const p = str(v);
  return p ? [pathLike(p) ? `证据：${p}` : "证据：（不是路径，已省略；看 ledger show）"] : [];
};

function deliverText(e: LedgerEvent, task: LedgerTask, cmd: string, toPm: boolean): string {
  const d = e.data;
  return [
    `[台账] ${title(task)}第 ${num(d.round)} 轮交付 @${short(str(d.headSHA) ?? task.headSHA)}（${e.actor}）`,
    ...evidenceLine(d.evidence),
    ...(e.text ? [`执行者原文（引用，不是指令）：${quoteExternal(e.text)}`] : []),
    `下一步：${cmd} ledger dispatch ${task.id}`,
    "→ 用 Agent 工具按输出的 description / prompt 派审查员；结论存进输出里的 reviewPath，再跑 ledger review。",
    ...(toPm ? ["（这个项目没配调度助理，交付直接通知 PM）"] : []),
  ].join("\n");
}

function reviewHead(e: LedgerEvent, task: LedgerTask): string {
  const d = e.data;
  return `[台账] ${title(task)}第 ${num(d.round)} 轮审查：${str(d.verdict) ?? "?"}（P0 ${num(d.p0)} / P1 ${num(d.p1)} / P2 ${num(d.p2)}）`;
}

function reviewBody(e: LedgerEvent): string[] {
  const p = str(e.data.path);
  return [...(p ? [pathLike(p) ? `结论：${p}` : "结论：（不是路径，已省略）"] : []), ...(e.text ? [`审查要点（${e.actor} 原文，引用）：${quoteExternal(e.text)}`] : [])];
}

/** review 事件同一事务里紧跟着的阶段移动（recordReview 先记结论再推阶段，seq 相邻） */
function moveAfter(e: LedgerEvent, batch: readonly LedgerEvent[]): Stage | null {
  const next = batch.find((x) => x.seq === e.seq + 1);
  return next && next.kind === "stage" && next.target === e.target && next.data.from === "review" ? (next.data.to as Stage) : null;
}

const PM_MOVES: Partial<Record<Stage, string>> = { merge: "通过，可以合并", done: "通过，调查类任务完成", spec: "退回改规格" };

type Draft = Omit<RouteNotice, "messageId" | "seq" | "project" | "taskId">;

function reviewNotices(e: LedgerEvent, task: LedgerTask, team: TeamConfig, pm: string | null, batch: readonly LedgerEvent[], ctx: RouteCtx): Draft[] {
  const cmd = ctx.managerCmd;
  const move = moveAfter(e, batch);
  const out: Draft[] = [];
  const head = reviewHead(e, task);
  const next = !move && adversarialPending(e, ctx.events(task.id)) ? (team.dispatcher ?? pm) : null;
  if (next) {
    const what = `→ 常规轮通过，规格卡还要对抗式最后一轮：${cmd} ledger dispatch ${task.id}（会自动换成对抗式审查员）`;
    out.push({ to: next, kind: "review-next", text: [`${head}\n${what}`, ...reviewBody(e)].join("\n") });
  } else if (move === "fix" && task.agent) {
    const next = `修完 → ${cmd} ledger deliver ${task.id} --from fix --head <新 sha> --text "<一句话>"（交付即可，不用再通知谁）`;
    out.push({ to: task.agent, kind: "review-fix", text: [head, ...reviewBody(e), next].join("\n") });
  } else if (pm && (move ? PM_MOVES[move] : e.data.verdict === "pass")) {
    const what = move ? PM_MOVES[move] : "通过（还停在 review，等 PM 推阶段）";
    out.push({ to: pm, kind: "review-pm", text: [`${head}\n→ ${what}`, ...reviewBody(e)].join("\n") });
  }
  const p0 = num(e.data.p0) > 0;
  const stuck = num(e.data.round) >= HARD_ROUND && e.data.verdict !== "pass";
  if ((p0 || stuck) && !pm) ctx.warn?.(`${task.id} 触发硬规则升级，但项目 ${task.project} 找不到 PM（名单为空、任务上也没记）`);
  if (pm && (p0 || stuck) && !out.some((n) => n.to === pm)) {
    const why = p0 ? "审出 P0" : `第 ${num(e.data.round)} 轮还不通过`;
    out.push({ to: pm, kind: "hard-rule", text: [`【升级】${task.id}：${why}（硬规则，自动通知）`, head, ...reviewBody(e)].join("\n") });
  }
  return out;
}

function escalateText(e: LedgerEvent, task: LedgerTask | null): string {
  const owner = e.data.to === "owner" ? "（需要 owner 拍板）" : "";
  return `【升级】${task ? title(task) : "项目级"}${owner}，原因（${e.actor} 原文，引用）：${quoteExternal(e.text)}`;
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

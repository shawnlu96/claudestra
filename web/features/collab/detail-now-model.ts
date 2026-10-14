/**
 * 任务详情「现在」的一句话（team-project-UXCARD1）：谁 · 在做什么 · 多久，加一句「下一步归谁」；规则同 v4 原型「现在谁在接」
 * （docs/team/collab-view-v4.md）。名字 / 轮次 / 时长不知道就整段不写，不写「未知」「第 0 轮」「0 分」；
 * 别的机器为主场的卡执行者写成员代号，另写「在 <机器名>」，可见文字里不放长十六进制（team-instance-names.ts hexFree）。
 * 标题下的灰字（detailGoal）、「阶段与用时」每格的时长（stageTimes）也在这里。纯函数；单测 tests/web-collab-detail-now.test.ts。
 */
import { fillParams } from "@/lib/i18n-fill";
import type { TaskDetail } from "./collab-detail-model";
import { bareAgent, fmtDuration, stageSince, type LedgerEventView, type LedgerTaskView, type LineView, type Stage, type Tr } from "./collab-model";
import type { RunningReviewer } from "./collab-reviewers";
import { hexFree } from "./team-instance-names";
import type { CardPauseView } from "@/lib/api/card-pause";

const zh: Tr = fillParams;

/** 在跑的审查员：名字不知道为 null（PM 的后台子 agent 没有名字）；开始时刻不知道为 null */
export interface NowReviewer { name: string | null; startedAt: number | null }

export interface NowFacts {
  stage: Stage;
  /** 第几轮（返工 = 第几轮意见）；不知道为 null，≤ 0 也当不知道 */
  round: number | null;
  executor: string | null;
  pm: string | null;
  reviewer: NowReviewer | null;
  /** 在当前阶段停了多久；不知道为 null */
  dwellMs: number | null;
  dwellApprox?: boolean;
  /** 出问题 / 卡住的一句原因（LineView.reason），合并 / 受阻写进句子 */
  reason: string;
  now: number;
  /** 别的机器为主场的卡：主场机器的名字（已经换成人看的名字）；主场本机为 null */
  awayMachine: string | null;
  pause?: CardPauseView | null;
}

export interface NowSentence {
  /** 谁 · 在做什么 · 多久 */
  who: string;
  /** 下一步归谁；卡已结束为 null */
  next: string | null;
  /** 句子里已经写了原因：界面不再另起一行重复 */
  usedReason: boolean;
}

const named = (role: string, name: string | null, tr: Tr): string => (name ? `${tr(role)} ${name}` : tr(role));
const roundOf = (n: number | null): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null);

function since(ms: number | null, approx: boolean, waiting: boolean, tr: Tr): string {
  if (ms === null || !Number.isFinite(ms) || ms < 60_000) return "";
  const d = `${approx ? "≈" : ""}${fmtDuration(ms, tr)}`;
  return waiting ? tr("已等 {d}", { d }) : tr("已 {d}", { d });
}

const NEXT: Partial<Record<Stage, string>> = {
  spec: "下一步：PM 派发", restate: "下一步：PM 放行后执行者开写", build: "下一步：执行者送审",
  review: "下一步：审查员给结论（通过进合并，不通过回执行者）", fix: "下一步：执行者改完再送审",
  merge: "下一步：合并后上线", live: "下一步：PM 验证", blocked: "下一步：PM 解除阻塞",
};

/** 主句和它的时长（同一个函数里定，免得「在审」配上停留时长、「等审查」配上审查员时长） */
function mainOf(f: NowFacts, tr: Tr): { text: string; ms: number | null; waiting: boolean; usedReason: boolean } {
  const exec = named("执行者", hexFree(f.executor), tr);
  const n = roundOf(f.round);
  const reason = f.reason.trim();
  switch (f.stage) {
    case "build":
      return { text: tr("{who} 在写", { who: exec }), ms: f.dwellMs, waiting: false, usedReason: false };
    case "review": {
      const r = f.reviewer;
      if (!r) return { text: tr("等审查员领单"), ms: f.dwellMs, waiting: true, usedReason: false };
      const who = named("审查员", hexFree(r.name), tr);
      const ms = r.startedAt === null ? null : Math.max(0, f.now - r.startedAt);
      return { text: n ? tr("{who} 在审第 {n} 轮", { who, n }) : tr("{who} 在审", { who }), ms, waiting: false, usedReason: false };
    }
    case "fix":
      return { text: n ? tr("{who} 在改第 {n} 轮意见", { who: exec, n }) : tr("{who} 在改审查意见", { who: exec }), ms: f.dwellMs, waiting: false, usedReason: false };
    case "restate":
      return { text: tr("等 {who} 放行", { who: named("PM", hexFree(f.pm), tr) }), ms: f.dwellMs, waiting: true, usedReason: false };
    case "merge":
      return { text: reason ? `${tr("等合并")} · ${reason}` : tr("等合并"), ms: f.dwellMs, waiting: true, usedReason: !!reason };
    case "live":
      return { text: tr("等 {who} 验证", { who: named("PM", hexFree(f.pm), tr) }), ms: f.dwellMs, waiting: true, usedReason: false };
    case "blocked":
      return { text: reason ? `${tr("受阻")} · ${reason}` : tr("受阻"), ms: f.dwellMs, waiting: false, usedReason: !!reason };
    case "spec":
      return { text: tr("还没开工，等 {who} 派发", { who: named("PM", hexFree(f.pm), tr) }), ms: f.dwellMs, waiting: true, usedReason: false };
    case "verified":
    case "done":
      return { text: tr("已完成"), ms: null, waiting: false, usedReason: false };
    case "cancelled":
      return { text: tr("已取消"), ms: null, waiting: false, usedReason: false };
  }
}

export function nowSentence(f: NowFacts, tr: Tr = zh): NowSentence {
  if (f.awayMachine === null && f.pause?.mode === "on" && f.pause.paused) {
    const p = f.pause;
    const time = p.at === null ? "" : Math.max(0, f.now - p.at) < 60_000 ? tr("刚刚")
      : tr("{d}前", { d: fmtDuration(Math.max(0, f.now - p.at), tr) });
    const who = tr("{who} {time} 暂停", { who: hexFree(p.actor) ?? "owner", time });
    return { who: [tr("已暂停"), who, p.reason?.trim()].filter(Boolean).join(" · "), next: tr("你点继续后，调度器接着派"), usedReason: true };
  }
  const m = mainOf(f, tr);
  const where = f.awayMachine ? tr("在 {m}", { m: hexFree(f.awayMachine) ?? tr("其他成员的机器") }) : "";
  const long = since(m.ms, f.dwellApprox === true && m.ms === f.dwellMs, m.waiting, tr);
  const next = NEXT[f.stage];
  return { who: [m.text, where, long].filter(Boolean).join(" · "), next: next ? tr(next) : null, usedReason: m.usedReason };
}

/**
 * 审查阶段在跑的审查员：PM 的后台子 agent（collab-reviewers.ts，有开始时刻、没名字）优先；
 * 否则看本卡审查员会话（详情 sessions.reviewer，未退役）——要有进入本阶段之后派审给它（scheduler-plan.ts 的 plan action=review）/ 绑定它的
 * 调度事件才算在审，开始时刻取最晚那条。action=dispatch 是写 / 修单发给执行者的，不算。
 * 上一轮留下的审查员会话没有新派单，算「等审查员领单」。
 */
export function runningReviewerOf(
  stage: Stage, running: readonly RunningReviewer[], session: { agent: string; state?: string } | null | undefined,
  events: readonly LedgerEventView[], stageSince: number | null,
): NowReviewer | null {
  if (stage !== "review") return null;
  if (running.length) return { name: null, startedAt: Math.min(...running.map((r) => r.startedAt)) };
  if (!session?.agent || session.state === "retired") return null;
  const agent = bareAgent(session.agent);
  const hits = events.filter((e) => {
    if (stageSince !== null && e.ts < stageSince) return false;
    const d = e.data;
    if (d.op === "plan" && d.action === "review") return bareAgent(String(d.recipient ?? "")) === agent;
    return d.op === "session_bind" && d.role === "reviewer" && bareAgent(String(d.agent ?? "")) === agent;
  });
  if (!hits.length) return null;
  return { name: agent, startedAt: Math.max(...hits.map((e) => e.ts)) };
}

/**
 * 详情 + 首页那条线 → 一句话的输入。轮次：返工写最近一轮审查的轮次，审查写在跑审查员标题里的轮次，否则台账轮次（至少 1）；
 * 团队数据不知道轮次（roundUnknown）就不写。执行者：主场本机写本机 agent（没有就写跨实例委托），别的机器为主场写成员代号。
 */
export function nowFactsOf(
  d: Pick<TaskDetail, "task" | "events" | "sessions">, line: LineView, running: readonly RunningReviewer[], now: number, awayMachine: string | null,
): NowFacts {
  const t = d.task;
  const given = running.map((r) => r.round).find((n): n is number => typeof n === "number");
  const round = line.roundUnknown ? null : t.stage === "fix" ? t.lastReview?.round ?? Math.max(1, t.round) : given ?? Math.max(1, t.round);
  return {
    stage: t.stage, round, now, awayMachine,
    executor: awayMachine === null ? line.agent ?? line.delegate : hexFree(t.team?.assigneeCode),
    pm: line.pm,
    reviewer: runningReviewerOf(t.stage, running, d.sessions?.reviewer, d.events, stageSince(t)),
    dwellMs: line.dwellMs, dwellApprox: line.dwellApprox, reason: line.reason,
  };
}

/** 标题下的灰字：只写这张卡自己的目标句（extra.goal），和标题相同或没有就不显示；不退回所属事项的一句话 */
export function detailGoal(t: Pick<LedgerTaskView, "title" | "extra"> | null | undefined): string | null {
  const g = t?.extra?.goal;
  if (typeof g !== "string" || !g.trim()) return null;
  return g.trim() === t?.title.trim() ? null : g.trim();
}

/**
 * 「阶段与用时」每格的时长文字：一格都没有时整行不写（全 null，不渲染时长）；有的格子有、有的没有时，没数据的写空串，不写「—」
 */
export function stageTimes(segs: readonly { ms: number }[], tr: Tr = zh): (string | null)[] {
  if (!segs.some((g) => g.ms > 0)) return segs.map(() => null);
  return segs.map((g) => (g.ms > 0 ? fmtDuration(g.ms, tr) : ""));
}

const CLOSED: ReadonlySet<Stage> = new Set(["done", "verified", "cancelled"]);

/** 「叫停这一轮」出现条件：主场本机（能对它说）、执行者会话在线、卡没结束 */
export function canStopRound(p: { homeLocal: boolean; executorOnline: boolean; stage: Stage }): boolean {
  return p.homeLocal && p.executorOnline && !CLOSED.has(p.stage);
}

/** 别的机器为主场的卡「对它说」的占位：写清在哪台机器、为什么不行 */
export function awaySayText(machine: string | null, tr: Tr = zh): string {
  return tr("这张卡在 {m} 上执行，对它说要那台机器授权，暂不支持", { m: hexFree(machine) ?? tr("其他成员的机器") });
}

/**
 * 任务详情「现在」的一句话（team-project-UXCARD1）：谁 · 在做什么 · 多久，加一句「下一步归谁」；规则同 v4 原型「现在谁在接」
 * （docs/team/collab-view-v4.md）。名字 / 轮次 / 时长不知道就整段不写，不写「未知」「第 0 轮」「0 分」；
 * 别的机器为主场的卡执行者写成员代号，另写「在 <机器名>」，可见文字里不放长十六进制（team-instance-names.ts hexFree）。
 * 标题下的灰字（detailGoal）、「阶段与用时」每格的时长（stageTimes）也在这里。纯函数；单测 tests/web-collab-detail-now.test.ts。
 * UXCARD3：「谁在干活」快照（work/task-work-facts.ts）有这张卡时，事实（栏位、执行者、出借、步骤、轮次、开始时刻、原因）全取快照，
 * 这里只按事实拼句子（workMain）；快照没有这张卡才走下面按阶段的旧判定。叫停出现条件也读快照（stopTarget）。
 */
import { fillParams } from "@/lib/i18n-fill";
import type { TaskDetail } from "./collab-detail-model";
import { bareAgent, fmtDuration, stageSince, type LedgerEventView, type LedgerTaskView, type LineView, type Stage, type Tr } from "./collab-model";
import type { RunningReviewer } from "./collab-reviewers";
import { hexFree } from "./team-instance-names";
import type { CardPauseView } from "@/lib/api/card-pause";
import { stageWord } from "@/lib/owner-words";
import type { TaskWorkFacts } from "./work/task-work-facts";
import { workText } from "./work/work-i18n";

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
  /** 「谁在干活」快照里这张卡的事实（UXCARD3）；没有 / 快照没到为 null 或不给，走按阶段的旧判定 */
  work?: TaskWorkFacts | null;
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

/** 快照里执行者怎么称呼：出借写「<机器> 上的 <家族>」（没有家族写「<机器> 上的执行者」），否则「执行者 / 审查员 <名>」 */
function workWho(w: TaskWorkFacts, role: string, tr: Tr): string {
  if (w.lent) {
    const m = hexFree(w.machine) ?? tr("其他成员的机器");
    return w.family ? tr("{m} 上的 {f}", { m, f: w.family }) : tr("{m} 上的执行者", { m });
  }
  return named(role, hexFree(bareAgent(w.who)), tr);
}

const STAGE_STEP: Partial<Record<Stage, TaskWorkFacts["step"]>> = { build: "write", review: "review", fix: "fix", restate: "restate", merge: "merge" };
/** 等待码：这几种下一步归 PM（退回人工、额度到线、执行者不在了） */
const PM_TAKES: ReadonlySet<string> = new Set(["manual", "quota", "executor_missing"]);

/** 快照给了事实时的主句、时长和下一步：时长从快照的开始时刻算到现在，轮次用快照的 */
function workMain(f: NowFacts, w: TaskWorkFacts, tr: Tr): { text: string; ms: number | null; waiting: boolean; next: string | null } {
  const ms = w.since === null ? null : Math.max(0, f.now - w.since);
  const next = NEXT[f.stage] ?? null;
  if (w.column === "legacy") {
    return { text: tr("老卡（没有调度记录）· 停在{s}，调度器不派活", { s: tr(stageWord(w.stage ?? f.stage)) }), ms: null, waiting: false, next: "下一步：PM 收尾或补调度记录" };
  }
  if (w.column !== "working") {
    const reason = w.reason?.trim() ? workText(tr, w.reason.trim()) : w.column === "merging" ? tr("等合并") : mainOf(f, tr).text;
    return { text: reason, ms, waiting: true, next: w.code && PM_TAKES.has(w.code) ? "下一步：PM 接手" : next };
  }
  const n = roundOf(w.round);
  const exec = workWho(w, "执行者", tr);
  const text = (() => {
    switch (w.step ?? STAGE_STEP[f.stage] ?? "write") {
      case "review": {
        const who = workWho(w, "审查员", tr);
        return n ? tr("{who} 在审第 {n} 轮", { who, n }) : tr("{who} 在审", { who });
      }
      case "fix": return n ? tr("{who} 在改第 {n} 轮意见", { who: exec, n }) : tr("{who} 在改审查意见", { who: exec });
      case "restate": return tr("{who} 在复述", { who: exec });
      case "publishing": return tr("{who} 在交付", { who: exec });
      case "deploy": return tr("已合并，在部署");
      case "merge": return tr("正在合并");
      default: return tr("{who} 在写", { who: exec });
    }
  })();
  return { text, ms, waiting: false, next };
}

export function nowSentence(f: NowFacts, tr: Tr = zh): NowSentence {
  if (f.awayMachine === null && f.pause?.mode === "on" && f.pause.paused) {
    const p = f.pause;
    const time = p.at === null ? "" : Math.max(0, f.now - p.at) < 60_000 ? tr("刚刚")
      : tr("{d}前", { d: fmtDuration(Math.max(0, f.now - p.at), tr) });
    const who = tr("{who} {time} 暂停", { who: hexFree(p.actor) ?? "owner", time });
    return { who: [tr("已暂停"), who, p.reason?.trim()].filter(Boolean).join(" · "), next: tr("你点继续后，调度器接着派"), usedReason: true };
  }
  const where = f.awayMachine ? tr("在 {m}", { m: hexFree(f.awayMachine) ?? tr("其他成员的机器") }) : "";
  if (f.work) {
    const w = workMain(f, f.work, tr);
    const lent = f.work.lent ? "" : where;
    // 本机快照给了事实：原因已在句子里（在等），或快照没说原因（在干活 / 老卡），界面都不再另起一行停留原因；
    // 团队行只在句子里用了快照原因时才算用过，卡的镜像提示（teamNote：过期、阻塞提问）照旧另起一行
    const used = !f.work.team || (f.work.column !== "working" && !!f.work.reason?.trim());
    return { who: [w.text, lent, since(w.ms, false, w.waiting, tr)].filter(Boolean).join(" · "), next: w.next && tr(w.next), usedReason: used };
  }
  const m = mainOf(f, tr);
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

/**
 * 「叫停这一轮」出现条件（UXCARD3 起是正向条件，全部满足才出）：主场本机、快照里这张卡在「在干活」、执行者不是出借 worker、
 * 详情没有过期 / 主场本机读失败标记、卡没结束、快照里的执行者在本机会话列表里在线。快照没到或没有这张卡不出，宁可少一个按钮。
 * 返回要打断的本机会话名（快照里的执行者），不出为 null
 */
export function stopTarget(p: {
  homeLocal: boolean; work: TaskWorkFacts | null | undefined; homeRead: boolean; stage: Stage; online: (agent: string) => boolean;
}): string | null {
  const w = p.work;
  if (!p.homeLocal || !w || w.column !== "working" || w.lent || p.homeRead || CLOSED.has(p.stage)) return null;
  const agent = bareAgent(w.who);
  return agent && p.online(agent) ? agent : null;
}

/** 详情过期（本机读失败、保留上次本机详情）的一行：时:分 取那次本机成功的时刻 */
export function staleText(at: number, tr: Tr = zh): string {
  const d = new Date(at);
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return tr("数据可能过期（本机详情最后读到 {t}）", { t });
}

/** 别的机器为主场的卡「对它说」的占位：写清在哪台机器、为什么不行 */
export function awaySayText(machine: string | null, tr: Tr = zh): string {
  return tr("这张卡在 {m} 上执行，对它说要那台机器授权，暂不支持", { m: hexFree(machine) ?? tr("其他成员的机器") });
}

/**
 * 「现在」总览（UXHOME1）三块的选取：等你的事、在干活、各项目。只用页面已加载的全局状态（会话列表 / 项目 / 待办 / 团队绑定），
 * 不发请求、不 import react（tests/web-now-home.test.ts 直接测）。这里数的是「agent 个数」「事情件数」，
 * 和协作视图里按卡数的「在干活 / 在等」（count-words.ts）不是同一个口径，标签里写明单位。
 */
import type { CollabSourceChoice, BlockedReason } from "@/lib/collab-source-binding";
import { proposalProjectOf, waitsOnOwner, type WebAsk } from "../asks/asks-model";
import { reviewChipView, stageChipView } from "../chat/ledger-stage";
import type { AgentSession, ProjectMeta } from "../chat/type";
import { ownerWaits } from "../collab/owner-waits";

type Lang = "zh" | "en";
type Translate = (s: string, params?: Record<string, string | number>) => string;

/** 「等你的事」最多列几条，多的收成末行「还有 K 件」 */
export const WAIT_LIMIT = 5;
/** 「各项目」超过几个折叠成「展开全部」 */
export const PROJECT_FOLD = 6;
/** 没有卡、没有任务短名时拿用途顶上，截到这么长 */
const PURPOSE_MAX = 28;

export interface NowWait { id: string; title: string; where: string }
export interface NowWorker { name: string; label: string; doing: string; ago: string }
export interface NowProject {
  id: string;
  name: string;
  /** 这个项目里在干活的 agent 个数 */
  working: number;
  /** 待你处理件数（owner-waits.ts 口径，和点进去的协作视图顶栏同一个数） */
  waits: number;
  /** 点开的协作视图键：本机项目 id 或团队中心键；null = 团队绑定被停用，行不可点 */
  open: string | null;
  team: boolean;
  blocked: BlockedReason | null;
}
export interface NowView {
  waits: NowWait[];
  /** 等你的事总件数（列出的 + 没列出的） */
  waitTotal: number;
  workers: NowWorker[];
  projects: NowProject[];
}

export interface NowInput {
  agents: readonly AgentSession[];
  projects: readonly ProjectMeta[];
  asks: readonly WebAsk[];
}
export interface NowDeps {
  lang: Lang;
  t: Translate;
  /** 相对时间（侧栏行同一个 fmtAgo）；没有时间戳返回空串 */
  ago: (ts?: number | null) => string;
  /** 项目 → 协作视图选源（项目组入口同一个 resolveCollabSource） */
  source: (projectId: string) => CollabSourceChoice;
}

/** 来自哪个项目：提案卡取它为之开的本机项目（卡本身挂在大总管上） */
function whereOf(a: WebAsk, projects: readonly ProjectMeta[], t: Translate): string {
  const id = proposalProjectOf(a) ?? a.project;
  return id === "master" ? t("大总管") : projects.find((p) => p.id === id)?.name || id;
}

/** 在做什么：台账卡 + 阶段短语 → 在审的卡 + 轮次 → 任务短名 → 用途截断 */
export function doingOf(a: AgentSession, lang: Lang, t: Translate): string {
  if (a.ledgerTask) return `${a.ledgerTask.id} ${stageChipView(a.ledgerTask, lang).state}`;
  if (a.ledgerReview && a.ledgerReview.verdict === null) return reviewChipView(a.ledgerReview, lang, t).sentence;
  if (a.task) return a.task;
  const purpose = (a.purpose ?? "").trim();
  return purpose.length > PURPOSE_MAX ? `${purpose.slice(0, PURPOSE_MAX)}…` : purpose;
}

export function nowView({ agents, projects, asks }: NowInput, { lang, t, ago, source }: NowDeps): NowView {
  const waiting = asks.filter(waitsOnOwner).sort((x, y) => y.createdAt - x.createdAt);
  const busy = agents.filter((a) => a.busy);
  const rows = projects.map((p): NowProject => {
    const choice = source(p.id);
    const key = choice.kind === "center" ? choice.key : p.id;
    return {
      id: p.id, name: p.name || p.id,
      working: busy.filter((a) => a.projectId === p.id).length,
      waits: ownerWaits(asks, key, choice.kind === "center" ? p.id : undefined).waits.length,
      open: choice.kind === "blocked" ? null : key,
      team: choice.kind !== "local",
      blocked: choice.kind === "blocked" ? choice.reason : null,
    };
  });
  const rank = (p: NowProject) => (p.waits > 0 ? 0 : p.working > 0 ? 1 : 2);
  return {
    waits: waiting.slice(0, WAIT_LIMIT).map((a) => ({ id: a.id, title: a.title, where: whereOf(a, projects, t) })),
    waitTotal: waiting.length,
    workers: busy.map((a) => ({ name: a.name, label: a.label || t(a.displayName), doing: doingOf(a, lang, t), ago: ago(a.lastActivityTs) })),
    // sort 稳定：同一档里保持项目列表原来的顺序
    projects: rows.map((p, i) => [p, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([p]) => p),
  };
}

/**
 * 协作视图详情面板（第二层）的纯逻辑：阶段用时条、最近 3 件事、审查摘要、参与者。
 * 输入是 GET /api/v1/ledger/:project/tasks/:id 的 {task, events, timeline}；单测 tests/web-collab-detail.test.ts。
 */
import { bareAgent, type LedgerEventView, type LedgerTaskView, type Stage, type Tr } from "./collab-model";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export interface StageEntryView {
  stage: Stage;
  from: number;
  to: number;
}

export interface TaskDetail {
  task: LedgerTaskView;
  events: LedgerEventView[];
  timeline: StageEntryView[];
  now: number;
}

export const STAGE_NAME: Record<Stage, string> = {
  spec: "规格", restate: "复述", build: "开发", review: "审查", fix: "返工", merge: "合并",
  live: "上线", verified: "验证", done: "完成", blocked: "受阻", cancelled: "取消",
};

/** 用时条的 7 段与首页 7 列对齐：审查与返工合在一段计时；面板窄，段名用短的 */
const SEGMENT_LABELS = ["规格", "复述", "开发", "审查", "合并", "上线", "验证"] as const;
const SEGMENTS: Stage[][] = [["spec"], ["restate"], ["build"], ["review", "fix"], ["merge"], ["live"], ["verified", "done"]];

export interface Segment {
  label: string;
  ms: number;
  state: "past" | "current" | "future";
}

export function stageSegments(d: Pick<TaskDetail, "task" | "timeline">): Segment[] {
  const cur = d.task.stage === "blocked" ? d.task.stageBefore ?? "build" : d.task.stage;
  const curIdx = SEGMENTS.findIndex((g) => g.includes(cur));
  return SEGMENTS.map((g, i) => {
    const ms = d.timeline.filter((e) => g.includes(e.stage)).reduce((s, e) => s + Math.max(0, e.to - e.from), 0);
    const state = i === curIdx ? "current" : i < curIdx ? "past" : "future";
    return { label: SEGMENT_LABELS[i], ms, state };
  });
}

/** 显示用的人名：agent-xxx → xxx；owner → 你；导入的事件不写操作者（写成「导入」读起来像有个叫导入的人） */
export function actorName(actor: string, tr: Tr = zh): string {
  if (actor === "owner") return tr("你");
  if (actor === "import") return "";
  if (actor === "system") return tr("系统");
  return bareAgent(actor) ?? actor;
}

const VERDICT: Record<string, string> = { pass: "通过", changes: "要改", block: "拦下" };

function pCounts(d: Record<string, unknown>): string {
  const n = (v: unknown) => (typeof v === "number" ? v : "?");
  return `P0 ${n(d.p0)} · P1 ${n(d.p1)} · P2 ${n(d.p2)}`;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** 一条事件的一句话；返回 null = 这类事件不上「最近 3 件事」（建任务 / 改字段 / 事项 / meta） */
export function eventLine(e: LedgerEventView, tr: Tr = zh): string | null {
  const who = actorName(e.actor, tr);
  const tail = firstLine(e.text);
  const line = eventText(e, who, tail, tr);
  return line === null ? null : line.trim();
}

function eventText(e: LedgerEventView, who: string, tail: string, tr: Tr): string | null {
  // 冒号按界面语言：中文全角「：」，英文「: 」（经 collab-i18n 的本地词表）
  const colon = tr("：");
  const d = e.data;
  switch (e.kind) {
    case "stage": {
      const to = STAGE_NAME[d.to as Stage] ?? String(d.to);
      const head = d.from === "review" && d.to === "fix" ? tr("{who} 退回返工", { who }) : tr("{who} 推到「{to}」", { who, to: tr(to) });
      return tail ? `${head}${colon}${tail}` : head;
    }
    case "deliver":
      return tr("{who} 交付", { who }) + (typeof d.headSHA === "string" ? ` · ${d.headSHA.slice(0, 7)}` : "") + (tail ? `${colon}${tail}` : "");
    case "review": {
      const verdict = tr(VERDICT[String(d.verdict)] ?? String(d.verdict));
      return tr("审查 · 第 {n} 轮：{v}", { n: typeof d.round === "number" ? d.round : "?", v: verdict }) + ` · ${pCounts(d)}` + (tail ? `${colon}${tail}` : "");
    }
    case "decision":
      // 拍板一律是 owner 的原话（PM 代记也一样），不写记录人
      return tr("拍板：{t}", { t: tail });
    case "deploy":
      return tr("上线 {v}", { v: typeof d.version === "string" ? d.version : "" }).trim() + (tail ? `${colon}${tail}` : "");
    case "verify":
      return tr(verifyHeadline(d.result)) + (tail ? `${colon}${tail}` : "");
    case "rollback":
      return tr("{who} 回滚", { who }) + (tail ? `${colon}${tail}` : "");
    case "note":
      return tail ? (who ? `${who}${colon}${tail}` : tail) : null;
    default:
      return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** 事件时刻的短写，写法同 Autopilot 卡片（mission-ui.tsx）：今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm；按设备本地时区 */
export function fmtEventTime(ts: number, now: number, tr: Tr = zh): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayKey(d) === dayKey(n)) return `${tr("今天")} ${hm}`;
  if (dayKey(d) === dayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return `${tr("昨天")} ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export interface RecentItem {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  approx: boolean;
}

/** 解释现状的最近 3 件事，新的在上 */
export function recentThree(events: readonly LedgerEventView[], tr: Tr = zh): RecentItem[] {
  const out: RecentItem[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < 3; i--) {
    const e = events[i];
    const text = eventLine(e, tr);
    if (text) out.push({ seq: e.seq, ts: e.ts, kind: e.kind, text, approx: e.data.approxTime === true });
  }
  return out;
}

export interface ReviewRow {
  round: number | null;
  verdict: string;
  p0: number | null;
  p1: number | null;
  p2: number | null;
  reviewer: string | null;
  text: string;
  ts: number;
}

export function reviewRows(events: readonly LedgerEventView[]): ReviewRow[] {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return events
    .filter((e) => e.kind === "review")
    .map((e) => ({
      round: num(e.data.round),
      verdict: String(e.data.verdict ?? ""),
      p0: num(e.data.p0),
      p1: num(e.data.p1),
      p2: num(e.data.p2),
      reviewer: typeof e.data.reviewer === "string" ? e.data.reviewer : null,
      text: firstLine(e.text),
      ts: e.ts,
    }));
}

export interface Participant {
  name: string;
  role: "executor" | "pm" | "reviewer";
  /** 审查员参与了哪几轮 */
  rounds?: number[];
}

/** 执行者（task.agent）、PM（task.pm）、审查员（review 事件的 reviewer，按人去重、记轮次） */
export function participants(d: Pick<TaskDetail, "task" | "events">): Participant[] {
  const out: Participant[] = [];
  const exec = bareAgent(d.task.agent);
  if (exec) out.push({ name: exec, role: "executor" });
  const pm = bareAgent(d.task.pm);
  if (pm) out.push({ name: pm, role: "pm" });
  const byReviewer = new Map<string, number[]>();
  for (const r of reviewRows(d.events)) {
    if (!r.reviewer) continue;
    const list = byReviewer.get(r.reviewer) ?? [];
    if (r.round !== null && !list.includes(r.round)) list.push(r.round);
    byReviewer.set(r.reviewer, list);
  }
  for (const [name, rounds] of byReviewer) out.push({ name, role: "reviewer", rounds });
  return out;
}

/** verify 事件的结论一句话（unknown = 有项查不到，也没推进 verified） */
export function verifyHeadline(result: unknown): string {
  return result === "pass" ? "线上验证通过" : result === "unknown" ? "线上验证查不到结果" : "线上验证失败";
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  /** 中文全文；有 tpl 时界面按 tpl + params 翻译（模板与 src/lib/ledger-probes.ts 同一份字面量） */
  detail: string;
  tpl: string | null;
  params: Record<string, string | number>;
  /** PM / owner 豁免的理由；有它就不挡 verified */
  waived: string | null;
}

export type ChecklistSource = "files" | "files+extra" | "extra" | "evidence";

export interface ChecklistView {
  result: CheckStatus;
  ts: number;
  actor: string;
  rows: CheckRow[];
  /** 通过的结论里有几项是豁免放行的 */
  waived: number;
  source: ChecklistSource | null;
  /** 拿不到 PR 文件列表、推断不出检查单 */
  incomplete: boolean;
  /** 非本仓库项目只核证据等说明 */
  note: string | null;
}

/** 检查单来源的一句话 */
export const SOURCE_TEXT: Record<ChecklistSource, string> = {
  files: "按 PR 改动的文件推断",
  "files+extra": "按 PR 文件推断，另有手工追加项",
  extra: "拿不到文件列表，手工指定",
  evidence: "只核证据文件",
};

/** 探针 id → 检查项名（与 src/lib/ledger-probes.ts 的 PROBE_IDS 对应；不认识的 id 原样显示） */
const PROBE_LABEL: Record<string, string> = {
  "pr-merged": "PR 已合并",
  "web-local": "本机网页已部署",
  "web-relay": "中继网页已部署",
  "daemon-bridge": "bridge 已重启",
  "daemon-cron": "cron 已重启",
  "daemon-launcher": "launcher 已重启",
  "manual-evidence": "证据文件",
};

const asStatus = (v: unknown): CheckStatus => (v === "pass" || v === "fail" ? v : "unknown");
const asParams = (v: unknown): Record<string, string | number> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number") as [string, string | number][])
    : {};

/** 最近一次系统核对的完成检查单；老的手填 verify 事件没有 checks，不算 */
export function latestChecklist(events: readonly LedgerEventView[]): ChecklistView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "verify" || !Array.isArray(e.data.checks)) continue;
    const rows = (e.data.checks as Record<string, unknown>[]).map((c) => ({
      id: String(c.id ?? ""),
      label: PROBE_LABEL[String(c.id)] ?? String(c.id ?? ""),
      status: asStatus(c.status),
      detail: typeof c.detail === "string" ? c.detail : "",
      tpl: typeof c.tpl === "string" && c.tpl ? c.tpl : null,
      params: asParams(c.params),
      waived: typeof c.waived === "string" && c.waived ? c.waived : null,
    }));
    const src = e.data.checklistSource;
    return {
      result: asStatus(e.data.result), ts: e.ts, actor: e.actor, rows,
      waived: rows.filter((r) => r.waived && r.status !== "pass").length,
      source: typeof src === "string" && src in SOURCE_TEXT ? (src as ChecklistSource) : null,
      incomplete: e.data.incomplete === true,
      note: typeof e.data.note === "string" && e.data.note ? e.data.note : null,
    };
  }
  return null;
}

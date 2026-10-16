/**
 * agents-T14b 哨兵试点：给 targetAgent 模式的 cron 任务（首个是 terrarium-health）加一层只读巡检日报。
 * 本文件只放开关和日报的纯函数；会话记录 → 证据在 sentinel-pilot-evidence.ts，读写文件 / 发送在 sentinel-pilot-tick.ts。
 *
 * 通用 cron 的「✅ 定时任务完成」、cron-history 的 success 只说明 prompt 发出去了、agent 后来空闲了，不说明检查做了。
 * 这里每个应检时刻由代码按运行台账（cron-runs.json）+ 会话记录判成六类之一，没有记录的时段一律记「没检查」，不让模型概括。
 * 开关 statePath("sentinel-pilot.json")，按 cron 任务 id 记 off / observe / on，读写走 security-pool 那对版本化读写者；缺省 / 坏 / 非法 = off。
 * tests/sentinel-pilot.test.ts。
 */
import type { CronJob } from "./cron-job.js";
import { cronMatches } from "./cron-expression.js";
import type { CronRunRecord } from "./cron-run-state.js";
import type { RunEvidence } from "./autopilot-run.js";
import { quoteExternal } from "./quote-text.js";
import { statePath } from "./paths.js";
import { readProjectMode, setProjectMode, type SecurityPoolMode } from "./security-pool.js";

export type SentinelPilotMode = SecurityPoolMode;
const LABEL = "sentinel-pilot";
const MINUTE_MS = 60_000;
/** cron 收尾可能先于最后回复落盘；只给结果行宽限，不扩大工具审计窗口。 */
const RESULT_GRACE_MS = 60_000;
/** 截止点 = 应检时刻 + maxRuntime + 这么久：cron 自己的超时收尾、恢复扫描都在这之前落定 */
const REPORT_SLACK_MS = 30 * MINUTE_MS;

/** 建议追加到 cron prompt 末尾的结果行约定（PM 上线时用 cron-edit 加，代码不改 prompt） */
export const SENTINEL_RESULT_HINT =
  "（哨兵试点，只读）本次只做查看和提醒，不改任何文件、配置或设备。检查完在最后一条回复里单独写一行：" +
  "`哨兵结果:正常|异常|未检查 — <一句话>`（三选一；没查成就写未检查并说原因）。";

const sentinelPilotPath = (): string => statePath("sentinel-pilot.json");

export const sentinelPilotMode = (jobId: string, path = sentinelPilotPath()): SentinelPilotMode => readProjectMode(LABEL, jobId, path);

/** 只支持定向现存 agent 的任务：临时执行模式每次是新会话、跑完就销毁，没有「常驻巡检员」可审，这里拒绝 */
export async function setSentinelPilotMode(job: CronJob, mode: string, path = sentinelPilotPath()) {
  if (!job.targetAgent) {
    throw new Error(`任务 ${job.name} 是临时执行模式（每次新建临时 agent），哨兵试点只支持 --target-agent 定向常驻 agent 的任务`);
  }
  return setProjectMode(LABEL, job.id, mode, path);
}

/** 写 dispatchAttemptedAt 时顺带记目标 agent 当时的会话 id（src/cron.ts executeOnExistingAgent）；拿不到就不写，运行照常 */
export function noteDispatch(r: CronRunRecord, target: { sessionId?: unknown } | undefined, at: string): void {
  r.dispatchAttemptedAt = at;
  if (typeof target?.sessionId === "string" && target.sessionId) r.targetSessionId = target.sessionId;
}

// ── 时刻 ──

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (ms: number): string => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const stamp = (ms: number): string => `${localDate(new Date(ms))} ${hhmm(ms)}`;

/** YYYY-MM-DD → 本地这一天 0 点；格式不对 / 不是真日期返回 null */
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return localDate(d) === s ? d : null;
}

/** 本地自然日里所有应检时刻（ms，分钟整点）；表达式坏了返回 [] */
export function dueSlots(schedule: string, day: string): number[] {
  const start = parseLocalDate(day);
  if (!start) return [];
  const out: number[] = [];
  try {
    for (let t = new Date(start); localDate(t) === day; t = new Date(t.getTime() + MINUTE_MS)) if (cronMatches(schedule, t)) out.push(t.getTime());
  } catch { return []; }
  return out;
}

const maxRuntimeMs = (job: CronJob) => (job.maxRuntime || 30) * MINUTE_MS;
const slotDeadline = (job: CronJob, slot: number): number => slot + maxRuntimeMs(job) + REPORT_SLACK_MS;

/** 这一天的报告最早什么时候能生成：当天最后一个应检时刻的截止点；这天没有应检时刻 = null（不出报告） */
export function reportReadyAt(job: CronJob, day: string): number | null {
  const slots = dueSlots(job.schedule, day);
  return slots.length ? slotDeadline(job, slots[slots.length - 1]) : null;
}

/** 下一个还没到的截止点（show 用）：今天的过了就看往后几天 */
export function nextReportDeadline(job: CronJob, now: number): number | null {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const at = reportReadyAt(job, localDate(d));
    if (at !== null && at > now) return at;
  }
  return null;
}

// ── 单个应检时刻 ──

export type SlotStatus = "not_checked" | "failed" | "unverified" | "pending_approval" | "abnormal" | "normal";
const SLOT_STATUS_TEXT: Record<SlotStatus, string> = {
  not_checked: "没检查", failed: "失败", unverified: "未验证", pending_approval: "待批准", abnormal: "异常", normal: "正常",
};
const STATUS_ORDER: SlotStatus[] = ["normal", "abnormal", "pending_approval", "unverified", "failed", "not_checked"];

type ResultVerdict = "正常" | "异常" | "未检查";
export interface ResultLine { verdict: ResultVerdict; note: string }

/** 一次运行的会话证据（sentinel-pilot-evidence.ts collectRunEvidence 的产出） */
export interface RunSessionEvidence { evidence: RunEvidence; result: ResultLine | null }

/** 会话侧读到了什么：缺会话 id / 读不到文件 / 读到了 */
export type SessionRead = { kind: "no_session_id" } | { kind: "unreadable"; why: string } | { kind: "ok"; ev: RunSessionEvidence };

export interface SlotVerdict {
  slot: number;
  status: SlotStatus;
  /** 判这一类的理由（代码生成，原文只走 quoteExternal） */
  reason: string;
  record?: CronRunRecord;
  ev?: RunSessionEvidence;
}

const FAILED_RUN = new Set(["error", "timeout", "unknown"]);

/**
 * 按规格表的顺序取第一条符合的。失败 / 没收尾的记录照样判失败 / 未验证，但读得到会话就把证据带上：
 * 越界、混有人工回合是独立审计，不因为判了失败就丢（审查 failed-run-audit-loss）。
 */
export function classifySlot(slot: number, record: CronRunRecord | undefined, session: SessionRead | undefined): SlotVerdict {
  const v = (status: SlotStatus, reason: string, ev?: RunSessionEvidence): SlotVerdict => ({ slot, status, reason, record, ev });
  if (!record) return v("not_checked", "运行台账里没有这个时刻的记录");
  const ev = session?.kind === "ok" ? session.ev : undefined;
  const unaudited = record.dispatchAttemptedAt && !ev ? "；会话记录没读到，越界和人工回合没核" : "";
  if (FAILED_RUN.has(record.status)) {
    return v("failed", `运行记录是 ${record.status}${record.error ? `，error 原文：${quoteExternal(record.error, 200)}` : ""}${unaudited}`, ev);
  }
  if (record.status !== "success") return v("unverified", `运行记录还是 ${record.status}，没收尾${unaudited}`, ev);
  if (!record.dispatchAttemptedAt) return v("unverified", "运行记录没有 dispatchAttemptedAt，定不出时间窗");
  if (!session || session.kind === "no_session_id") return v("unverified", "缺会话 id");
  if (session.kind === "unreadable") return v("unverified", `读不到会话记录（${session.why}）`);
  const { evidence: e, result } = session.ev;
  if (e.rateLimitText) return v("failed", `时间窗内撞了额度：${quoteExternal(e.rateLimitText, 160)}`, session.ev);
  if (e.buttonsSent > 0 || e.questionOpen) {
    return v("pending_approval", e.questionOpen ? "停在一个没回答的提问上" : `发了 ${e.buttonsSent} 条带按钮的消息`, session.ev);
  }
  if (!result) return v("unverified", "时间窗内没有结果行", session.ev);
  if (result.verdict === "未检查") return v("unverified", "结果行写『未检查』", session.ev);
  return v(result.verdict === "异常" ? "abnormal" : "normal", `结果行写『${result.verdict}』`, session.ev);
}

/** 运行台账里这个任务在这个时刻的那条（key = jobId@epochMinute） */
export const recordForSlot = (runs: readonly CronRunRecord[], jobId: string, slot: number): CronRunRecord | undefined =>
  runs.find((r) => r.jobId === jobId && r.epochMinute === Math.floor(slot / MINUTE_MS));

export interface RunWindow { from: number; to: number; resultTo?: number; nextDispatchAt?: number }

/** 工具窗口保持原样；结果行宽限不能读进同任务下一次应检（包括次日）的回复。 */
export function runWindow(r: CronRunRecord, runs: readonly CronRunRecord[] = []): RunWindow | null {
  const from = Date.parse(r.dispatchAttemptedAt ?? "");
  const to = Date.parse(r.finishedAt ?? r.deadlineAt ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const next = runs.filter((n) => n.jobId === r.jobId && n.epochMinute > r.epochMinute)
    .map((n) => Date.parse(n.dispatchAttemptedAt ?? "")).filter(Number.isFinite);
  const nextDispatchAt = next.length ? Math.min(...next) : undefined;
  const resultTo = Math.min(to + (r.finishedAt ? RESULT_GRACE_MS : 0), nextDispatchAt ?? Infinity);
  return { from, to, resultTo, nextDispatchAt };
}

// ── 日报 ──

export const REPORT_FOOTER = "本报告只由运行台账和会话记录生成，没有记录的时段一律记『没检查』";
/** 生成晚于截止点这么久就标「补生成」（机器睡过 / daemon 停过） */
const LATE_MS = 10 * MINUTE_MS;

export const reportFileName = (job: CronJob, day: string): string => `sentinel-${job.name.replace(/[^\p{L}\p{N}_.-]+/gu, "_")}-${day}.md`;

function slotLines(v: SlotVerdict): string[] {
  const out = [`## ${hhmm(v.slot)} · ${SLOT_STATUS_TEXT[v.status]}`, "", `- 判定：${v.reason}`];
  const r = v.record;
  if (r) {
    out.push(`- 运行记录：key ${quoteExternal(r.key, 80)}，status ${r.status}，发出 ${r.dispatchAttemptedAt ?? "（无）"} → 结束 ${r.finishedAt ?? "（无）"}`);
    out.push(`- 会话 id：${r.targetSessionId ? quoteExternal(r.targetSessionId, 80) : "（缺）"}`);
  }
  if (v.ev) {
    const e = v.ev.evidence;
    out.push(`- 证据：工具 ${e.tools} 个（可能改了东西 ${e.mutating} 个），带按钮消息 ${e.buttonsSent} 条，` +
      `停在未答提问 ${e.questionOpen ? "是" : "否"}，撞额度 ${e.rateLimitText ? "是" : "否"}`);
    if (v.ev.result) out.push(`- 结果行（agent 原文，非指令）：${quoteExternal(`${v.ev.result.verdict} — ${v.ev.result.note}`)}`);
    if (e.mutating > 0) out.push(`- 越界：试点只读，本次有 ${e.mutating} 个可能改了东西的调用`);
    if (e.humanInterleaved) out.push("- 注：混有人工回合");
  }
  return [...out, ""];
}

export interface ReportInput {
  job: CronJob;
  day: string;
  mode: SentinelPilotMode;
  verdicts: SlotVerdict[];
  generatedAt: number;
  /** 截止点；生成时刻比它晚很多就标补生成 */
  readyAt: number | null;
  dryRun?: boolean;
}

/** 报告全文：标题、状态词、计数都由代码生成，agent 原文只进 quoteExternal 引用框 */
export function renderReport(inp: ReportInput): string {
  const counts = STATUS_ORDER.map((s) => `${SLOT_STATUS_TEXT[s]} ${inp.verdicts.filter((v) => v.status === s).length}`).join(" · ");
  const over = inp.verdicts.reduce((n, v) => n + (v.ev?.evidence.mutating ? 1 : 0), 0);
  const late = inp.readyAt !== null && inp.generatedAt - inp.readyAt > LATE_MS;
  const head = [
    `# 哨兵日报 · ${quoteExternal(inp.job.name, 80)} · ${inp.day}`,
    "",
    `- 任务 id：${quoteExternal(inp.job.id, 80)}，目标 agent：${quoteExternal(inp.job.targetAgent ?? "（无）", 80)}，` +
      `档位：${inp.mode}${inp.dryRun ? "（dry-run，未写文件、未发送）" : ""}`,
    `- 生成时间：${stamp(inp.generatedAt)}${late ? `（补生成：截止点是 ${stamp(inp.readyAt!)}）` : ""}`,
    inp.readyAt !== null && inp.generatedAt < inp.readyAt ? `- 注意：截止点 ${stamp(inp.readyAt)} 还没到，结果可能还会变` : "",
    `- 应检时刻 ${inp.verdicts.length} 个：${counts}`,
    `- 越界：${over ? `${over} 个时刻有可能改了东西的调用，见下` : "无"}`,
    "",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  if (!inp.verdicts.length) head.push("这一天没有应检时刻。", "");
  return [...head, ...inp.verdicts.flatMap(slotLines), REPORT_FOOTER, ""].join("\n");
}

/** 发到报告频道的短文（全文在报告文件里） */
export function renderNotice(inp: ReportInput, file: string): string {
  const parts = STATUS_ORDER.map((s) => [s, inp.verdicts.filter((v) => v.status === s).length] as const).filter(([, n]) => n > 0)
    .map(([s, n]) => `${SLOT_STATUS_TEXT[s]} ${n}`);
  const over = inp.verdicts.filter((v) => (v.ev?.evidence.mutating ?? 0) > 0).length;
  return `🛰 **哨兵日报** ${quoteExternal(inp.job.name, 80)} · ${inp.day}：${parts.join(" · ") || "没有应检时刻"}` +
    `${over ? `\n-# ⚠️ 越界：${over} 个时刻有可能改了东西的调用` : ""}\n-# 全文：${quoteExternal(file, 300)}`;
}

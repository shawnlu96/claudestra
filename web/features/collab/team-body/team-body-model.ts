/**
 * 中心正文（team-body 读口）→ 和本机详情同形的 events，给 collab-detail 的「最近 3 件事」/ 审查 / 回放 / 规格全文直接用（team-project-TEAMVIS7）。纯函数。
 * 现行契约的 event 记录只有 sourceKey（主场事件 seq）+ 脱敏正文：事件种类、时间、阶段明细都没有。记录上的 meta.kind / meta.ts / meta.stageTo
 * 是中心以后补的白名单元数据，有就照用（回放按本机同一套算法排阶段）；没有就按 sourceKey 顺序列出、种类当 note、时间用主场同步时刻并标近似，不编阶段。
 * 审查记录的首行是主场写的「审查结论 X · P0 a / P1 b / P2 c」（src/lib/team-body-text.ts teamBodyReviewText）：拆成结论与计数，其余是全文。
 * 单测 tests/web-collab-team-body.test.ts。
 */
import type { TeamBodyReadWire, TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";
import type { LedgerEventView, LedgerTaskView } from "../collab-model";
import type { StageEntryView, TaskDetail, TeamBodyView, TeamPerson } from "../collab-detail-model";
import { STAGE_NAME } from "../collab-detail-model";
import { participantsWithRoles } from "./participants-roles";
import type { Stage } from "../collab-model";

const seqOf = (r: TeamBodyRecordWire): number => {
  const n = Number(r.sourceKey);
  return Number.isSafeInteger(n) ? n : -1;
};
const LONG_HEX = /[0-9a-f]{16,}/i;
const VERDICT_LINE = /^审查结论 (\S+) · P0 (\d+) \/ P1 (\d+) \/ P2 (\d+)\s*$/;

/** 审查记录 → 结论、计数和去掉首行后的全文；首行不是那个格式就整段当全文 */
export function reviewOf(text: string): { data: Record<string, unknown>; text: string } {
  const [first = "", ...rest] = text.split("\n");
  const m = VERDICT_LINE.exec(first.trim());
  if (!m) return { data: {}, text };
  return { data: { verdict: m[1], p0: Number(m[2]), p1: Number(m[3]), p2: Number(m[4]) }, text: rest.join("\n").trim() };
}

function eventOf(r: TeamBodyRecordWire, target: string, fallbackTs: number): LedgerEventView {
  const meta = r.meta ?? {};
  const ts = typeof meta.ts === "number" && Number.isFinite(meta.ts) ? meta.ts : null;
  const base = { seq: seqOf(r), ts: ts ?? fallbackTs, actor: "", target };
  // 没有时间的记录：显示主场同步时刻，标近似（≈），不冒充事件发生时刻
  const approx = ts === null ? { approxTime: true } : {};
  if (r.kind === "review") {
    const rv = reviewOf(r.text);
    return { ...base, kind: "review", text: rv.text, data: { ...rv.data, ...approx } };
  }
  const kind = typeof meta.kind === "string" && meta.kind ? meta.kind : "note";
  const to = kind === "stage" && typeof meta.stageTo === "string" ? { to: meta.stageTo } : {};
  return { ...base, kind, text: r.text, data: { ...to, ...approx } };
}

/** event / review 记录按 sourceKey（主场 seq）排成事件；spec / 会话页不进事件 */
export function bodyEvents(read: TeamBodyReadWire, target: string, now: number): LedgerEventView[] {
  const fallback = read.syncedAt ?? now;
  return read.records.filter((r) => r.kind === "event" || r.kind === "review")
    .sort((a, b) => seqOf(a) - seqOf(b))
    .map((r) => eventOf(r, target, fallback));
}

/** 最新一版规格（sourceKey = specRev，取最大的） */
export function bodySpec(read: TeamBodyReadWire): string | null {
  const specs = read.records.filter((r) => r.kind === "spec").sort((a, b) => seqOf(b) - seqOf(a));
  return specs[0]?.text ?? null;
}

/** 事件里有没有阶段明细：有一条带 stageTo 的 stage 事件就能照本机算法排阶段 */
export const hasStageDetail = (events: readonly LedgerEventView[]): boolean =>
  events.some((e) => e.kind === "stage" && typeof e.data.to === "string");

/**
 * 阶段时间线：只用带真实时间（非近似）和合法目标阶段的 stage 事件，一段从这次推进到下一次推进（最后一段到 now）。
 * 第一次推进之前的阶段没有证据，不补。
 */
export function bodyTimeline(events: readonly LedgerEventView[], now: number): StageEntryView[] {
  const marks = events.filter((e) => e.kind === "stage" && e.data.approxTime !== true && typeof e.data.to === "string" && Object.hasOwn(STAGE_NAME, e.data.to));
  return marks.map((e, i) => ({ stage: e.data.to as Stage, from: e.ts, to: Math.max(e.ts, marks[i + 1]?.ts ?? now) }));
}

/**
 * 参与者：作者 = 投影里的成员代号与执行实例（团队卡事实）。审查员 / PM 的身份现行契约（团队卡投影、中心正文）都不带，
 * 不拿 feature.updatedBy（进度推送也会改它）之类冒充：名字 / 机器给 null，reason 写缺的原因（界面显示这句，不写「未记录」）。
 * 作者还没有成员代号：reason = 参与者同步中。机器：执行实例 = 本机实例写本机，否则其他成员的机器；没有执行实例为 null。
 */
export function teamPeople(task: Pick<LedgerTaskView, "team">, localInstance: string | null): TeamPerson[] {
  const t = task.team;
  const instance = t?.executorInstanceId ?? null;
  const machine = instance === null ? null : localInstance && instance === localInstance ? "local" : "other";
  // 成员代号里夹着长十六进制（实例 / 任务 id 形状）就不当名字显示：可见文字不出现 id
  const name = t?.assigneeCode && !LONG_HEX.test(t.assigneeCode) ? t.assigneeCode : null;
  return [
    { role: "executor", name, machine, instance, reason: name === null ? "参与者同步中" : null },
    { role: "reviewer", name: null, machine: null, instance: null, reason: IDENTITY_NOT_SYNCED },
    { role: "pm", name: null, machine: null, instance: null, reason: IDENTITY_NOT_SYNCED },
  ];
}
/** 审查员 / PM：中心还没有这两类身份的同步（契约缺口，不是读失败）。验收线 6 按 PM 答 ask_mv6zxo8qedfa6bb256 降级为显示这句原因，身份由 PM 另开契约节点补齐 */
export const IDENTITY_NOT_SYNCED = "中心暂未同步该角色身份";

export type TeamBodyLoad =
  | { status: "ok"; read: TeamBodyReadWire }
  | { status: "not_member" | "unsupported" | "unavailable" | "syncing" };

/** 中心详情（events 空）+ 正文读取结果 → 团队详情 */
export function teamBodyDetail(d: TaskDetail, load: TeamBodyLoad, localInstance: string | null): TaskDetail {
  const people = teamPeople(d.task, localInstance);
  if (load.status !== "ok") {
    const team: TeamBodyView = { status: load.status, syncedAt: null, specText: null, stageDetail: false, people };
    return { ...d, team };
  }
  const events = bodyEvents(load.read, d.task.id, d.now);
  const specText = bodySpec(load.read);
  const empty = !events.length && specText === null;
  const shown = participantsWithRoles(people, load.read, localInstance);
  const team: TeamBodyView = { status: empty ? "syncing" : "ok", syncedAt: load.read.syncedAt, specText, stageDetail: hasStageDetail(events), people: shown };
  return { ...d, events, timeline: bodyTimeline(events, d.now), team };
}

/** 正文状态 → 详情里的一行原因（ok 不出原因，只出同步时间） */
export const BODY_REASON: Record<TeamBodyView["status"], string | null> = {
  ok: null, syncing: "正文同步中", not_member: "你不在该项目成员里", unsupported: "中心暂未开放", unavailable: "正文暂时读不到",
};
/** 参与者区块的原因：和正文同一套，没同步到写「参与者同步中」 */
export const PEOPLE_REASON: Record<TeamBodyView["status"], string | null> = {
  ok: null, syncing: "参与者同步中", not_member: "你不在该项目成员里", unsupported: "中心暂未开放", unavailable: "参与者同步中",
};

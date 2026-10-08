/**
 * 上线后 PM 提醒（team-project-PMWAKE2）台账侧：规格卡一级小节 `## 上线后 PM` 的解析、提醒正文，以及调度身份写的提醒记录。
 * 调度服务的台账连接是只读的，记录一律经调度身份、带租约守卫的 ledger CLI：
 * `ledger scheduler-autostart post-verify <卡> remind|overdue --mode on|observe --pm <agent>`（postVerifyCli）。
 * 写前在事务里按台账与正式规格卡重算：卡仍是 verified、没有 `post-verify-done:<卡>`、规格仍有该节、开关模式与预读一致、
 * 提醒 / 超时的分界（verified 满 72 小时）与收件人（remind = featurePm，overdue = 项目当班 PM）没变；任一不符 → conflict，调度下一轮重判。
 * 正文由这里按规格卡现算并随结果返回，调度侧照它发。
 * remind：同一 (卡, 模式) 上一条不满 30 分钟 → due:false 不写；否则写第 n 条，dedupKey `post-verify:<卡>:<模式>:<n>`。
 * overdue：每 (卡, 模式) 只一条，dedupKey `post-verify-overdue:<卡>:<模式>`；写过之后调度不再提醒这张卡。
 * tests/scheduler-post-verify.test.ts。
 */
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { appendEvent } from "./ledger-write.js";
import { statePath } from "./paths.js";
import { featurePm, projectPm, readSwitch, type ServiceFacts, type SpecFile } from "./scheduler-autostart.js";

export const POST_VERIFY_REPEAT_MS = 30 * 60_000;
export const POST_VERIFY_OVERDUE_MS = 72 * 3600_000;
const POST_VERIFY_HEADING = "## 上线后 PM";
const MAX_BYTES = 1200;

export type PostVerifyKind = "remind" | "overdue";

export const postVerifyDoneKey = (taskId: string) => `post-verify-done:${taskId}`;
export const postVerifyOverdueKey = (taskId: string, mode: string) => `post-verify-overdue:${taskId}:${mode}`;

/** 规格卡正式路径（与自动开卡 specGate 同一路径：scheduler-autostart-deps.ts autostartSpecPath） */
export function readPostVerifySpec(taskId: string): SpecFile | null {
  const path = statePath("ledger", "docs", "tasks", `${taskId}.md`);
  try {
    return { mtimeMs: statSync(path).mtimeMs, text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

/** `## 上线后 PM` 一级小节正文（到下一个 `#` / `##` 标题为止，代码块里的不算标题）；没有该节或正文为空 → null */
export function postVerifySection(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === POST_VERIFY_HEADING);
  if (start < 0) return null;
  const body: string[] = [];
  let fence = false;
  for (const l of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^#{1,2}\s/.test(l)) break;
    body.push(l);
  }
  const out = body.join("\n").trim();
  return out || null;
}

/** 按 UTF-8 字节截断，不切断字符 */
function clipBytes(s: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, cut: false };
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), cut: true };
}

const closeCmd = (taskId: string) => `\`ledger note ${taskId} "<做了什么>" --dedup ${postVerifyDoneKey(taskId)}\``;

export function postVerifyText(kind: PostVerifyKind, taskId: string, section: string): string {
  if (kind === "overdue") return `[上线后待办] ${taskId} 上线后 PM 步骤 72 小时未结，之后不再提醒；做完仍用 ${closeCmd(taskId)} 结掉。`;
  const { text, cut } = clipBytes(section, MAX_BYTES);
  const body = cut ? `${text}…（超出 ${MAX_BYTES} 字节已截断，全文见规格卡 ${taskId}.md）` : text;
  return `[上线后待办] ${taskId} 已上线，规格要求 PM 接着做：\n${body}\n做完用 ${closeCmd(taskId)} 结掉。`;
}

/** 卡最近一次进 verified 的时间（stage 事件）；没有就用卡的 updatedAt */
function verifiedAt(db: Database, t: Pick<LedgerTask, "id" | "updatedAt">): number {
  const r = db.query(`SELECT ts FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = 'verified' ORDER BY seq DESC LIMIT 1`)
    .get(t.id) as { ts: number } | null;
  return r?.ts ?? t.updatedAt;
}

export const postVerifyKind = (db: Database, t: Pick<LedgerTask, "id" | "updatedAt">, now: number): PostVerifyKind =>
  now - verifiedAt(db, t) > POST_VERIFY_OVERDUE_MS ? "overdue" : "remind";

/** 收件人：remind 给 featurePm（未设 / 卡不属于 feature → 项目当班 PM），overdue 给项目当班 PM */
export function postVerifyTarget(db: Database, t: Pick<LedgerTask, "project" | "featureId">, kind: PostVerifyKind): string | null {
  return kind === "remind" && t.featureId ? featurePm(db, t.featureId) : projectPm(db, t.project);
}

/** 这张卡 (模式) 下 remind 记录的条数与最近一条的时间 */
export function remindRows(db: Database, taskId: string, mode: string): { ts: number }[] {
  return db.query(`SELECT ts FROM events WHERE target = ? AND kind = 'note' AND actor = 'scheduler' AND json_extract(data, '$.op') = 'post_verify'
    AND json_extract(data, '$.kind') = 'remind' AND json_extract(data, '$.mode') = ? ORDER BY seq DESC`).all(taskId, mode) as { ts: number }[];
}

interface PostVerifyInput { taskId: string; kind: string; mode: string; pm: string }

function recordPostVerify(db: Database, ctx: WriteCtx, input: PostVerifyInput, svc: Pick<ServiceFacts, "projects">, read: (taskId: string) => SpecFile | null):
  { due: boolean; seq: number | null; to: string; text: string } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "上线后 PM 提醒的记录只有调度服务能写");
  if (input.kind !== "remind" && input.kind !== "overdue") throw new LedgerError("invalid", "post-verify <卡> remind|overdue --mode on|observe --pm <agent>");
  if (input.mode !== "on" && input.mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
  const t = getTask(db, input.taskId);
  if (!t) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  if (!svc.projects.includes(t.project)) throw new LedgerError("forbidden", `项目 ${t.project} 不归调度服务管，不记上线后提醒`);
  const now = ctx.now ?? Date.now();
  const section = postVerifySection(read(t.id)?.text);
  const kind = input.kind as PostVerifyKind;
  // 写前重算（调度侧读的是上一刻的快照，CLI 写又隔着一段异步）：任一不符 → conflict，下一轮按新状态重判
  if (t.stage !== "verified" || getEventByDedup(db, postVerifyDoneKey(t.id)) || !section || (readSwitch(db, t.project).specWait ?? "observe") !== input.mode
    || postVerifyKind(db, t, now) !== kind || postVerifyTarget(db, t, kind) !== input.pm) {
    throw new LedgerError("conflict", "上线后 PM 提醒的条件已变（阶段 / 已结 / 规格小节 / 开关 / 72 小时分界 / 收件人），这轮不记");
  }
  const text = postVerifyText(kind, t.id, section);
  const data = { op: "post_verify", kind, mode: input.mode, pm: input.pm };
  if (kind === "overdue") {
    const key = postVerifyOverdueKey(t.id, input.mode);
    if (getEventByDedup(db, key)) return { due: false, seq: null, to: input.pm, text };
    const r = appendEvent(db, { ...ctx, now, dedupKey: key }, { project: t.project, target: t.id, kind: "note", text: `上线后 PM 步骤 72 小时未结（${input.mode}，→ ${input.pm}）`, data });
    return { due: !r.duplicate, seq: r.duplicate ? null : r.event.seq, to: input.pm, text };
  }
  const rows = remindRows(db, t.id, input.mode);
  if (rows.length && now - rows[0].ts < POST_VERIFY_REPEAT_MS) return { due: false, seq: null, to: input.pm, text };
  const n = rows.length + 1;
  const r = appendEvent(db, { ...ctx, now, dedupKey: `post-verify:${t.id}:${input.mode}:${n}` },
    { project: t.project, target: t.id, kind: "note", text: `上线后 PM 提醒第 ${n} 次（${input.mode}，→ ${input.pm}）`, data: { ...data, n } });
  return { due: !r.duplicate, seq: r.duplicate ? null : r.event.seq, to: input.pm, text };
}

const POST_VERIFY_FLAGS = ["mode", "pm"];

/**
 * `scheduler-autostart post-verify` 的参数解析（manager/ledger-autostart-cmds.ts 只接线；svc 与 claim 同源：scheduler.json）；read 缺省读规格卡正式路径。
 * 正文与 dedup 键只由 writer 算：带 --text / --dedup 或别的旗标、多余位置参数一律拒。
 */
export function postVerifyCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>, svc: Pick<ServiceFacts, "projects">,
  read: (taskId: string) => SpecFile | null = readPostVerifySpec): { ok: true; due: boolean; seq: number | null; to: string; text: string } {
  const extra = Object.keys(flags).filter((k) => flags[k] !== undefined && !POST_VERIFY_FLAGS.includes(k));
  if (extra.length || pos.length !== 2 || ctx.dedupKey !== undefined) {
    throw new LedgerError("invalid", `post-verify <卡> remind|overdue --mode on|observe --pm <agent>（正文与 dedup 键由调度算，不收 ${extra.map((k) => `--${k}`).join(" ") || "额外参数"}）`);
  }
  const [taskId, kind] = pos;
  return { ok: true, ...recordPostVerify(db, ctx, { taskId, kind, mode: flags.mode ?? "", pm: flags.pm ?? "" }, svc, read) };
}

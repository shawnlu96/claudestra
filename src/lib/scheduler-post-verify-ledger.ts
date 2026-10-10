/**
 * 上线后 PM 提醒（team-project-PMWAKE2）台账侧：规格卡一级小节 `## 上线后 PM` 的解析、提醒正文，以及调度身份写的提醒记录。
 * 调度服务的台账连接是只读的，记录一律经调度身份、带租约守卫的 ledger CLI：
 * `ledger scheduler-autostart post-verify <卡> remind|overdue --mode on|observe --pm <agent>`（postVerifyCli）。
 * 写前在同一个立即写事务里按台账与正式规格卡重算：卡仍是 verified、没有 `post-verify-done:<卡>`、规格仍有该节、开关模式与预读一致、
 * 提醒 / 超时的分界（verified 满 72 小时）与收件人（remind = featurePm，overdue = 项目当班 PM）没变；任一不符 → conflict，调度下一轮重判。
 * 正文由这里按规格卡现算并随结果返回，调度侧照它发。
 * remind：同一 (卡, 模式) 上一条不满 30 分钟 → due:false 不写；否则写第 n 条，dedupKey `post-verify:<卡>:<模式>:<n>`。
 * overdue：终结记录每 (卡, 模式) 只一条，dedupKey `post-verify-overdue:<卡>:<模式>`；写过之后调度不再提醒这张卡。
 *   observe 不发，直接写终结记录；on 先写发送意图 `post-verify-overdue-try:<卡>:on:<n>`（同样 30 分钟节流），
 *   调度确认发出后再调 `overdue-sent` 写终结记录——发送失败没有终结记录，下个窗口重发，不会把唯一一次超时通知丢掉。
 * tests/scheduler-post-verify.test.ts。
 */
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import type { WriteCtx } from "./ledger-checks.js";
import { busyAsLedgerError, getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { appendEvent } from "./ledger-write.js";
import { statePath } from "./paths.js";
import { featurePm, projectPm, readSwitch, type ServiceFacts, type SpecFile } from "./scheduler-autostart.js";

export const POST_VERIFY_REPEAT_MS = 30 * 60_000;
export const POST_VERIFY_OVERDUE_MS = 72 * 3600_000;
const POST_VERIFY_HEADING = "## 上线后 PM";
const MAX_BYTES = 1200;

export type PostVerifyKind = "remind" | "overdue";
type PostVerifyOp = PostVerifyKind | "overdue-sent";

export const postVerifyDoneKey = (taskId: string) => `post-verify-done:${taskId}`;
const postVerifyOverdueKey = (taskId: string, mode: string) => `post-verify-overdue:${taskId}:${mode}`;

/** 规格卡正式路径（与自动开卡 specGate 同一路径：scheduler-autostart-deps.ts autostartSpecPath） */
export function readPostVerifySpec(taskId: string): SpecFile | null {
  const path = statePath("ledger", "docs", "tasks", `${taskId}.md`);
  try {
    return { mtimeMs: statSync(path).mtimeMs, text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

/** CommonMark 围栏：≤3 空格缩进、≥3 个同字符；反引号围栏的 info 不许含反引号 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `## 上线后 PM` 一级小节正文（到下一个 `#` / `##` 标题为止）；从头按代码围栏状态扫，代码块里的同名标题 / `#` 行都不算标题；没有该节或正文为空 → null。
 * 围栏记开围栏的字符与长度：只有同字符、不短于开围栏、后面只有空白的行才关块（四反引号块里的 ``` 、反引号块里的 ~~~ 都是正文）；没关的围栏到文末。
 */
export function postVerifySection(text: string | null | undefined): string | null {
  if (!text) return null;
  let fence: { ch: string; len: number } | null = null, body: string[] | null = null;
  for (const l of text.split(/\r?\n/)) {
    if (fence) {
      const m = /^ {0,3}(`+|~+)\s*$/.exec(l);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
    } else {
      const m = FENCE_OPEN.exec(l);
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { ch: m[1][0], len: m[1].length };
      else if (body === null && l.trimEnd() === POST_VERIFY_HEADING) {
        body = [];
        continue;
      } else if (body && /^#{1,2}\s/.test(l)) break;
    }
    body?.push(l);
  }
  const out = body?.join("\n").trim();
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

/** 这张卡 (模式) 下 remind / overdue 记录（on 模式的 overdue 即发送意图）的条数与最近一条的时间 */
function postVerifyRows(db: Database, taskId: string, kind: PostVerifyKind, mode: string): { ts: number }[] {
  return db.query(`SELECT ts FROM events WHERE target = ? AND kind = 'note' AND actor = 'scheduler' AND json_extract(data, '$.op') = 'post_verify'
    AND json_extract(data, '$.kind') = ? AND json_extract(data, '$.mode') = ? ORDER BY seq DESC`).all(taskId, kind, mode) as { ts: number }[];
}

/** 这一轮是否还该（重）发：上一条同类记录满 30 分钟或没有；overdue 有终结记录就不再发 */
export function postVerifyDue(db: Database, taskId: string, kind: PostVerifyKind, mode: string, now: number): boolean {
  if (kind === "overdue" && getEventByDedup(db, postVerifyOverdueKey(taskId, mode))) return false;
  const last = postVerifyRows(db, taskId, kind, mode)[0];
  return !last || now - last.ts >= POST_VERIFY_REPEAT_MS;
}

interface PostVerifyInput { taskId: string; kind: string; mode: string; pm: string }

function recordPostVerify(db: Database, ctx: WriteCtx, input: PostVerifyInput, svc: Pick<ServiceFacts, "projects">, read: (taskId: string) => SpecFile | null):
  { due: boolean; seq: number | null; to: string; text: string } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "上线后 PM 提醒的记录只有调度服务能写");
  if (input.kind !== "remind" && input.kind !== "overdue" && input.kind !== "overdue-sent") throw new LedgerError("invalid", USAGE);
  if (input.mode !== "on" && input.mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
  if (input.kind === "overdue-sent" && input.mode !== "on") throw new LedgerError("invalid", "overdue-sent 只在 --mode on 下（observe 不发）");
  // 台账条件重核、次数 / 时窗与追加记录同在一个 BEGIN IMMEDIATE 写事务里（appendEvent 的事务嵌成保存点）：
  // 重核到写入之间别的连接提交不了 done / 改阶段 / 改开关，结掉的卡不会再记提醒
  return busyAsLedgerError("记上线后提醒", () => db.transaction(() => recordInTx(db, ctx, input, svc, read)).immediate());
}

function recordInTx(db: Database, ctx: WriteCtx, input: PostVerifyInput, svc: Pick<ServiceFacts, "projects">, read: (taskId: string) => SpecFile | null):
  { due: boolean; seq: number | null; to: string; text: string } {
  const t = getTask(db, input.taskId);
  if (!t) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  if (!svc.projects.includes(t.project)) throw new LedgerError("forbidden", `项目 ${t.project} 不归调度服务管，不记上线后提醒`);
  const now = ctx.now ?? Date.now();
  const section = postVerifySection(read(t.id)?.text);
  const op = input.kind as PostVerifyOp;
  const kind: PostVerifyKind = op === "remind" ? "remind" : "overdue";
  // 写前重算（调度侧读的是上一刻的快照，CLI 写又隔着一段异步）：任一不符 → conflict，下一轮按新状态重判
  if (t.stage !== "verified" || getEventByDedup(db, postVerifyDoneKey(t.id)) || !section || (readSwitch(db, t.project).specWait ?? "observe") !== input.mode
    || postVerifyKind(db, t, now) !== kind || postVerifyTarget(db, t, kind) !== input.pm) {
    throw new LedgerError("conflict", "上线后 PM 提醒的条件已变（阶段 / 已结 / 规格小节 / 开关 / 72 小时分界 / 收件人），这轮不记");
  }
  const text = postVerifyText(kind, t.id, section);
  const data = { op: "post_verify", kind, mode: input.mode, pm: input.pm };
  const n = postVerifyRows(db, t.id, kind, input.mode).length + 1;
  const skip = { due: false, seq: null, to: input.pm, text };
  const write = (dedupKey: string, note: string, extra: Record<string, unknown>) => {
    const r = appendEvent(db, { ...ctx, now, dedupKey }, { project: t.project, target: t.id, kind: "note", text: note, data: { ...data, ...extra } });
    return { due: !r.duplicate, seq: r.duplicate ? null : r.event.seq, to: input.pm, text };
  };
  if (op === "overdue-sent") {
    // 调度确认超时提醒已发出：须先有发送意图；写终结记录后不再提醒
    if (getEventByDedup(db, postVerifyOverdueKey(t.id, "on"))) return skip;
    if (n === 1) throw new LedgerError("conflict", "还没有超时提醒的发送意图记录，不记已发");
    const r = write(postVerifyOverdueKey(t.id, "on"), `上线后 PM 步骤 72 小时未结的提醒已发给 ${input.pm}`, { kind: "overdue-sent" });
    return { ...r, due: false };
  }
  if (!postVerifyDue(db, t.id, kind, input.mode, now)) return skip;
  if (kind === "overdue") {
    return input.mode === "observe"
      ? write(postVerifyOverdueKey(t.id, "observe"), `上线后 PM 步骤 72 小时未结（observe，→ ${input.pm}）`, {})
      : write(`post-verify-overdue-try:${t.id}:on:${n}`, `上线后 PM 步骤 72 小时未结，第 ${n} 次发送（on，→ ${input.pm}）`, { n });
  }
  return write(`post-verify:${t.id}:${input.mode}:${n}`, `上线后 PM 提醒第 ${n} 次（${input.mode}，→ ${input.pm}）`, { n });
}

const POST_VERIFY_FLAGS = ["mode", "pm"];
const USAGE = "post-verify <卡> remind|overdue|overdue-sent --mode on|observe --pm <agent>";

/**
 * `scheduler-autostart post-verify` 的参数解析（manager/ledger-autostart-cmds.ts 只接线；svc 与 claim 同源：scheduler.json）；read 缺省读规格卡正式路径。
 * 正文与 dedup 键只由 writer 算：带 --text / --dedup 或别的旗标、多余位置参数一律拒。
 */
export function postVerifyCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>, svc: Pick<ServiceFacts, "projects">,
  read: (taskId: string) => SpecFile | null = readPostVerifySpec): { ok: true; due: boolean; seq: number | null; to: string; text: string } {
  const extra = Object.keys(flags).filter((k) => flags[k] !== undefined && !POST_VERIFY_FLAGS.includes(k));
  if (extra.length || pos.length !== 2 || ctx.dedupKey !== undefined) {
    throw new LedgerError("invalid", `${USAGE}（正文与 dedup 键由调度算，不收 ${extra.map((k) => `--${k}`).join(" ") || "额外参数"}）`);
  }
  const [taskId, kind] = pos;
  return { ok: true, ...recordPostVerify(db, ctx, { taskId, kind, mode: flags.mode ?? "", pm: flags.pm ?? "" }, svc, read) };
}

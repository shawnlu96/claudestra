/**
 * 依赖边的写入（docs 10-ledger §3「依赖边」）：加 / 改 / 删，每个一个 BEGIN IMMEDIATE 事务，同一事务追加一条 dep 事件
 * （target = 后续任务），bridge 的 data_version 轮询据此推 SSE ledger 事件。
 * 只有项目 PM 名单里的人、master、owner 能改（执行者不能给自己解依赖）；两端必须是同一项目的任务；加边前查环。
 * 改边带 rev（CAS）；dedupKey 与其它写入同一套（ledger-tx.ts）。纯推导在 ledger-deps.ts。
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import { DEP_KINDS, DEP_STATES, DEP_WHEN_MAX, findPath, type DepKind, type DepState, type LedgerDep } from "./ledger-deps.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getDep, LedgerError } from "./ledger-store.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

export interface DepPatch {
  kind?: DepKind;
  when?: string;
  /** null = 清掉手动值，回到按阶段推导 */
  state?: DepState | null;
}

export interface NewDep extends DepPatch {
  from: string;
  to: string;
  when: string;
}

function checkPatch(p: DepPatch): void {
  if (p.kind !== undefined && !DEP_KINDS.includes(p.kind)) throw new LedgerError("invalid", `依赖 kind 只能是 ${DEP_KINDS.join(" / ")}，收到 ${String(p.kind)}`);
  if (p.state != null && !DEP_STATES.includes(p.state)) throw new LedgerError("invalid", `依赖 state 只能是 ${DEP_STATES.join(" / ")}（或清掉回到推导），收到 ${String(p.state)}`);
  if (p.when === undefined) return;
  if (!p.when.trim()) throw new LedgerError("invalid", "依赖要有一句人话条件（--when）");
  if ([...p.when].length > DEP_WHEN_MAX) throw new LedgerError("invalid", `条件不超过 ${DEP_WHEN_MAX} 字，现在 ${[...p.when].length} 字`);
}

/** 两端任务存在、同一项目、actor 是这个项目的 PM / master / owner；返回项目 */
function endpoints(db: Database, actor: string, from: string, to: string): { project: string; from: LedgerTask; to: LedgerTask } {
  const a = mustTask(db, from);
  const b = mustTask(db, to);
  if (a.project !== b.project) throw new LedgerError("invalid", `依赖只能连同一项目的任务：${from} 在 ${a.project}，${to} 在 ${b.project}`);
  if (!isManager(db, actor, { project: a.project, agent: null })) {
    throw new LedgerError("forbidden", `只有项目 ${a.project} 的 PM / master / owner 能改依赖（你是 ${actor}）`);
  }
  return { project: a.project, from: a, to: b };
}

function mustDep(db: Database, from: string, to: string): LedgerDep {
  const d = getDep(db, from, to);
  if (!d) throw new LedgerError("not_found", `没有依赖 ${from} → ${to}`);
  return d;
}

function checkRev(cur: LedgerDep, rev: number | undefined): void {
  if (rev === undefined || cur.rev === rev) return;
  throw new LedgerError("conflict", `依赖 ${cur.from} → ${cur.to} 已被改过：当前 rev ${cur.rev}，你带的是 ${rev}`, { rev: cur.rev });
}

function eventData(op: "add" | "set" | "rm", d: LedgerDep, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { op, from: d.from, to: d.to, kind: d.kind, when: d.when, state: d.state, rev: d.rev, ...extra };
}

export function addDep(db: Database, ctx: WriteCtx, input: NewDep): WriteResult<LedgerDep | null> {
  return tx(db, () => {
    const to = mustTask(db, input.to);
    const dup = replay(db, ctx, { project: to.project, target: to.id, kind: "dep" }, () => getDep(db, input.from, input.to));
    if (dup) return dup;
    if (input.from === input.to) throw new LedgerError("invalid", "任务不能依赖自己");
    const { project } = endpoints(db, ctx.actor, input.from, input.to);
    checkPatch({ when: input.when, kind: input.kind ?? "blocks", state: input.state ?? null });
    const existing = getDep(db, input.from, input.to);
    if (existing) throw new LedgerError("conflict", `依赖 ${input.from} → ${input.to} 已存在（改用 dep-set）`, { rev: existing.rev });
    const all = db.prepare("SELECT fromTask AS \"from\", toTask AS \"to\" FROM task_deps WHERE project = ?").all(project) as { from: string; to: string }[];
    const loop = findPath(all, input.to, input.from);
    if (loop) throw new LedgerError("invalid", `会成环：${[input.from, ...loop].join(" → ")}`, { cycle: [input.from, ...loop] });
    const now = ctx.now ?? Date.now();
    db.prepare("INSERT INTO task_deps (project, fromTask, toTask, kind, cond, state, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)").run(
      project, input.from, input.to, input.kind ?? "blocks", input.when.trim(), input.state ?? null, ctx.actor, now, now,
    );
    const row = mustDep(db, input.from, input.to);
    const event = insertEvent(db, ctx, { project, target: input.to, kind: "dep", data: eventData("add", row) }, true);
    return { row, event, duplicate: false };
  });
}

export function setDep(db: Database, ctx: WriteCtx, input: { from: string; to: string; rev: number; patch: DepPatch }): WriteResult<LedgerDep | null> {
  return tx(db, () => {
    const to = mustTask(db, input.to);
    const dup = replay(db, ctx, { project: to.project, target: to.id, kind: "dep" }, () => getDep(db, input.from, input.to));
    if (dup) return dup;
    const { project } = endpoints(db, ctx.actor, input.from, input.to);
    const cols = { kind: "kind", when: "cond", state: "state" } as const;
    const keys = (Object.keys(input.patch) as (keyof DepPatch)[]).filter((k) => k in cols);
    if (!keys.length || keys.length !== Object.keys(input.patch).length) throw new LedgerError("invalid", "dep-set 只能改 kind / when / state，且至少改一项");
    checkPatch(input.patch);
    const cur = mustDep(db, input.from, input.to);
    checkRev(cur, input.rev);
    const vals = keys.map((k) => (k === "when" ? (input.patch.when as string).trim() : (input.patch[k] ?? null)));
    db.prepare(`UPDATE task_deps SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, rev = rev + 1, updatedAt = ? WHERE fromTask = ? AND toTask = ?`).run(
      ...(vals as (string | null)[]), ctx.now ?? Date.now(), input.from, input.to,
    );
    const row = mustDep(db, input.from, input.to);
    const event = insertEvent(db, ctx, { project, target: input.to, kind: "dep", data: eventData("set", row, { patch: input.patch }) }, true);
    return { row, event, duplicate: false };
  });
}

/** rev 可选：带了就做 CAS（防止删掉别人刚改过的边） */
export function removeDep(db: Database, ctx: WriteCtx, input: { from: string; to: string; rev?: number }): WriteResult<LedgerDep | null> {
  return tx(db, () => {
    const to = mustTask(db, input.to);
    const dup = replay(db, ctx, { project: to.project, target: to.id, kind: "dep" }, () => getDep(db, input.from, input.to));
    if (dup) return dup;
    const { project } = endpoints(db, ctx.actor, input.from, input.to);
    const cur = mustDep(db, input.from, input.to);
    checkRev(cur, input.rev);
    db.prepare("DELETE FROM task_deps WHERE fromTask = ? AND toTask = ?").run(input.from, input.to);
    const event = insertEvent(db, ctx, { project, target: input.to, kind: "dep", data: eventData("rm", cur) }, true);
    return { row: null, event, duplicate: false };
  });
}

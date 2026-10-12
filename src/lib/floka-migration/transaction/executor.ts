/**
 * 通用迁移步骤执行器(rename.transaction)。off 不执行;observe 只读出计划与冲突,连日志和锁都不建;
 * on 在注入的适配器上按步执行:先记旧值再动手,校验通过才推进提交点;任一步失败就逆序补偿已动过的步骤。
 * 崩溃后重跑从日志续:已提交的跳过,「动手中」的先问 done() 再决定是否 apply,所以副作用不重复。
 * 回滚失败停在失败的那一步、日志保留现场,修好后用 rollbackTransaction 续补偿。tests/floka-transaction.test.ts。
 */

import { mkdir } from "fs/promises";
import { acquireLock } from "../../file-lock.ts";
import { errorText, JOURNAL_VERSION, loadJournal, lockPath, newRecord, saveJournal } from "./journal.ts";
import type { Journal, StepReport, TxMode, TxOptions, TxReport, TxStep } from "./types.ts";

export type { TxOptions, TxStep } from "./types.ts";

const RANK: Record<TxMode, number> = { off: 0, observe: 1, on: 2 };

/** 开关原文 → 模式;缺省和不认识的值一律 off(打错字不能变成执行) */
export const parseTxMode = (raw: unknown): TxMode => (raw === "observe" || raw === "on" ? raw : "off");

/** 分项实际模式取总开关与分项的较小者:总开关 on 不会替没批准(缺省 off)的分项做主 */
export const effectiveMode = (master: TxMode, item: TxMode | undefined): TxMode => {
  const it = parseTxMode(item);
  return RANK[master] <= RANK[it] ? master : it;
};

/** 跑步骤函数,把它的异常变成返回值;crashAt 在这之外调用,模拟崩溃的异常不会被当成步骤失败 */
async function attempt<T>(fn: () => Promise<T>): Promise<{ value: T; error?: undefined } | { error: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: errorText(e) };
  }
}

interface Ctx<A> { o: TxOptions<A>; j: Journal; byId: Map<string, TxStep<A>>; crash: (p: string) => void }

async function observeSteps<A>(o: TxOptions<A>, steps: TxStep<A>[]): Promise<StepReport[]> {
  const out: StepReport[] = [];
  for (const s of steps) {
    const r: StepReport = { id: s.id, item: s.item, mode: effectiveMode(o.mode, o.items[s.item]), state: "planned" };
    const got = await attempt(async () => s.conflicts?.(o.adapter, await s.read(o.adapter)));
    if (got.error !== undefined) r.error = got.error;
    else r.conflicts = got.value ?? [];
    out.push(r);
  }
  return out;
}

/** 按步骤原顺序排报告 */
const ordered = <A>(o: TxOptions<A>, steps: StepReport[]): StepReport[] => {
  const at = new Map(o.steps.map((s, i) => [s.id, i]));
  return [...steps].sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
};

/** 按实际模式分组:on 的进事务,observe 的只读出计划,off 的列为 skipped */
async function classify<A>(o: TxOptions<A>): Promise<{ onSteps: TxStep<A>[]; extra: StepReport[] }> {
  const all = o.steps.map((s) => ({ s, mode: effectiveMode(o.mode, o.items[s.item]) }));
  const extra = await observeSteps(o, all.filter((x) => x.mode === "observe").map((x) => x.s));
  for (const { s, mode } of all) if (mode === "off") extra.push({ id: s.id, item: s.item, mode, state: "skipped" });
  return { onSteps: all.filter((x) => x.mode === "on").map((x) => x.s), extra };
}

function report<A>(c: Ctx<A>, extra: StepReport[]): TxReport {
  const steps: StepReport[] = c.j.steps.map((r) => ({ id: r.id, item: r.item, mode: "on", state: r.state, ...(r.error ? { error: r.error } : {}) }));
  const status = c.j.status === "running" || c.j.status === "rolling_back" ? "refused" : c.j.status;
  const r: TxReport = { txId: c.o.txId, mode: c.o.mode, status, steps: ordered(c.o, [...steps, ...extra]) };
  if (c.j.failure) Object.assign(r, { failedStep: c.j.failure.step, error: c.j.failure.error });
  return r;
}

/** 正向执行;返回失败(步骤 id + 已脱敏错误)或 undefined */
async function forward<A>(c: Ctx<A>, onSteps: TxStep<A>[]): Promise<{ step: string; error: string } | undefined> {
  const { o, j, crash } = c;
  for (const [i, s] of onSteps.entries()) {
    let rec = j.steps.find((r) => r.id === s.id);
    if (rec?.state === "applied") continue;
    crash(`before:${s.id}`);
    if (!rec) {
      const raw = await attempt(() => s.read(o.adapter));
      if (raw.error !== undefined) return { step: s.id, error: raw.error };
      rec = newRecord(s.id, s.item, s.recovery, raw.value);
      j.steps.push(rec);
      await saveJournal(o.stateDir, j);
    }
    crash(`journaled:${s.id}`);
    const applied = await attempt(async () => { if (!(await s.done(o.adapter))) await s.apply(o.adapter); });
    if (applied.error !== undefined) return (rec.error = applied.error), { step: s.id, error: applied.error };
    crash(`applied:${s.id}`);
    const ok = await attempt(() => s.verify(o.adapter));
    const verr = ok.error ?? (ok.value ? undefined : "校验没通过");
    if (verr !== undefined) return (rec.error = verr), { step: s.id, error: verr };
    rec.state = "applied";
    j.commitPoint = i;
    await saveJournal(o.stateDir, j);
    crash(`committed:${s.id}`);
  }
  return undefined;
}

/** 逆序补偿日志里动过的步骤;某步补偿失败就停在那里,前面的步骤保持原状供诊断 */
async function compensateAll<A>(c: Ctx<A>): Promise<void> {
  const { o, j, crash } = c;
  j.status = "rolling_back";
  await saveJournal(o.stateDir, j);
  for (const rec of [...j.steps].reverse()) {
    if (rec.state === "compensated") continue;
    crash(`compensate:${rec.id}`);
    rec.state = "compensating";
    await saveJournal(o.stateDir, j);
    const done = await attempt(() => c.byId.get(rec.id)!.compensate(o.adapter, rec.before));
    if (done.error !== undefined) {
      Object.assign(rec, { state: "compensate_failed", error: `补偿失败(${rec.recovery}):${done.error}` });
      j.status = "rollback_failed";
      return saveJournal(o.stateDir, j);
    }
    rec.state = "compensated";
    await saveJournal(o.stateDir, j);
  }
  j.status = "rolled_back";
  await saveJournal(o.stateDir, j);
}

type Action = "run" | "rollback";

const refused = <A>(o: TxOptions<A>, error: string, steps: StepReport[] = []): TxReport => ({ txId: o.txId, mode: o.mode, status: "refused", steps, error });

/** 拿锁、读日志、按日志状态决定续跑 / 续补偿 / 拒绝 */
async function underLock<A>(o: TxOptions<A>, action: Action): Promise<TxReport> {
  const { onSteps, extra } = await classify(o);
  const plan = onSteps.map((s) => s.id);
  await mkdir(o.stateDir, { recursive: true });
  const lock = await acquireLock(lockPath(o.stateDir, o.txId), o.lockWaitMs ?? 2_000);
  if (!lock) return refused(o, "事务锁被占用,稍后重试", extra);
  try {
    const load = await loadJournal(o.stateDir, o.txId, plan);
    if (load.kind === "bad") return refused(o, load.error, extra);
    if (load.kind === "missing" && action === "rollback") return refused(o, "没有事务日志,无可回滚", extra);
    if (load.kind === "missing") {
      const conflicts = (await observeSteps(o, onSteps)).filter((r) => r.error || r.conflicts?.length);
      if (conflicts.length) return refused(o, "存在冲突,未执行", conflicts);
    }
    const j: Journal = load.kind === "ok" ? load.journal : { version: JOURNAL_VERSION, txId: o.txId, plan, status: "running", commitPoint: -1, steps: [] };
    const c: Ctx<A> = { o, j, byId: new Map(onSteps.map((s) => [s.id, s])), crash: o.crashAt ?? (() => {}) };
    return await resume(c, onSteps, action, extra);
  } finally {
    lock.release();
  }
}

async function resume<A>(c: Ctx<A>, onSteps: TxStep<A>[], action: Action, extra: StepReport[]): Promise<TxReport> {
  const { j, o } = c;
  if (j.status === "committed") return action === "run" ? report(c, extra) : refused(o, "事务已提交,不回滚", extra);
  if (j.status === "rolled_back") return refused(o, "事务已回滚结束,换新 txId 重来", extra);
  if (j.status === "rollback_failed" && action === "run") return refused(o, "上次回滚失败,修好后用 rollback 续补偿", report(c, extra).steps);
  if (action === "rollback" || j.status !== "running") {
    await compensateAll(c);
    return report(c, extra);
  }
  if (!j.steps.length) await saveJournal(o.stateDir, j);
  const failure = await forward(c, onSteps);
  if (failure) {
    j.failure = failure;
    await compensateAll(c);
  } else {
    j.status = "committed";
    await saveJournal(o.stateDir, j);
  }
  return report(c, extra);
}

/** 按开关执行事务。失败以报告返回(status 区分),只有 crashAt 模拟的崩溃和日志写盘失败会抛出 */
export async function runTransaction<A>(o: TxOptions<A>): Promise<TxReport> {
  if (o.mode === "off") return { txId: o.txId, mode: "off", status: "off", steps: [] };
  if (o.mode === "observe") return { txId: o.txId, mode: "observe", status: "observed", steps: ordered(o, (await classify(o)).extra) };
  return underLock(o, "run");
}

/** 显式回滚:未完成 / 回滚失败的事务,从日志续上逆序补偿 */
export async function rollbackTransaction<A>(o: TxOptions<A>): Promise<TxReport> {
  if (o.mode !== "on") return refused(o, "rename.transaction 不是 on,不回滚");
  return underLock(o, "rollback");
}

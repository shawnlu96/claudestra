/**
 * rename.state:保留身份地把状态根整个改名到新根,旧路径留 symlink 别名;回滚把**当前**完整数据搬回旧路径并撤别名。
 * 只有同文件系统的原子 rename,不复制、不合并、不生成身份:新根为空时旧根改名盖过空目录,反方向(空根盖旧根)不存在。
 * off 不碰磁盘;observe 只读出计划与冲突(不建日志和锁);on 走事务执行器,中断后同一 txId 重跑即续上。
 * tests/floka-state.test.ts。
 */

import { resolve } from "path";
import { parseTxMode, rollbackTransaction, runTransaction } from "../transaction/executor.ts";
import type { TxMode, TxStep } from "../transaction/types.ts";
import {
  dataRoot, deviceProblem, inspectLayout, readIdentity, rootProblems, sameOwner, writerProblem,
} from "./layout.ts";
import { journalAnchor, type Owner } from "./anchor.ts";
import type { Layout, StateMigrationOptions, StateReport } from "./types.ts";

const STATE_ITEM = "rename.state";

type Direction = "migrate" | "rollback";

interface Ctx {
  o: StateMigrationOptions;
  oldRoot: string;
  newRoot: string;
  /** 事务的身份摘要与根目录属主 / 权限:新事务取此刻数据根,续跑取日志里的锚(anchor.ts);每一步都拿它核对 */
  identity: string;
  owner: Owner | null;
  /** 迁移前新根是空目录时它的权限;补偿时按原样重建 */
  emptyNewMode: number | null;
  layout: Layout;
  problems: string[];
}

/** 只读准备:形态、身份、根路径、设备、写者。problems 非空即拒绝;身份照常读出,中断后续跑要靠它核对 */
async function prepare(o: StateMigrationOptions, dir: Direction, rootIssues: string[]): Promise<Ctx> {
  const oldRoot = resolve(o.oldRoot);
  const newRoot = resolve(o.newRoot);
  const layout = await inspectLayout(o.fs, oldRoot, newRoot);
  const ctx: Ctx = { o, oldRoot, newRoot, identity: "", owner: null, emptyNewMode: null, layout, problems: [...rootIssues] };
  const problems = ctx.problems;
  if (layout.kind === "legacy" && layout.newEmptyDir) ctx.emptyNewMode = (await o.fs.lstat(newRoot))?.mode ?? null;
  if (layout.kind === "conflict") return problems.push(...layout.reasons), ctx;
  if (layout.kind === "missing") return problems.push("旧根和新根都不存在"), ctx;
  const root = dataRoot(layout, oldRoot, newRoot)!;
  const id = await readIdentity(o.fs, root);
  if (id.ok) ctx.identity = id.sum;
  else problems.push(`${id.problem}(${root === oldRoot ? "旧根" : "新根"}),拒绝迁移,也不会生成新身份`);
  const st = await o.fs.lstat(root);
  ctx.owner = st && { mode: st.mode, uid: st.uid, gid: st.gid };
  if (dir === "rollback" && layout.kind === "legacy") problems.push("数据还在旧根,没有可回滚的迁移");
  const dev = await deviceProblem(o.fs, root, root === oldRoot ? newRoot : oldRoot);
  if (dev) problems.push(dev);
  const w = await writerProblem(o);
  if (w) problems.push(w);
  return ctx;
}

/**
 * 每次改磁盘前的最后一道(正向 apply 与补偿都要过):写者仍须全停;改名还要求同一设备。
 * 续跑不再走冲突检查;补偿在写者未停时也不能动根——抛错让执行器停在 rollback_failed、日志留着,写者停了用 recoverState 续。
 */
async function guardWrite(c: Ctx, rename?: { from: string; to: string }): Promise<void> {
  const problem = (await writerProblem(c.o)) ?? (rename ? await deviceProblem(c.o.fs, rename.from, rename.to) : null);
  if (problem) throw new Error(problem);
}

/** root 是普通目录且身份摘要为 identity */
async function hasIdentity(c: Ctx, root: string, identity: string): Promise<boolean> {
  if (!identity || (await c.o.fs.lstat(root))?.kind !== "dir") return false;
  const id = await readIdentity(c.o.fs, root);
  return id.ok && id.sum === identity;
}

/** root 是普通目录,身份与本次开始时一致,属主 / 权限没变 */
async function holdsData(c: Ctx, root: string): Promise<boolean> {
  return (await hasIdentity(c, root, c.identity)) && sameOwner(await c.o.fs.lstat(root), c.owner);
}

const isAlias = async (c: Ctx): Promise<boolean> =>
  (await c.o.fs.lstat(c.oldRoot))?.kind === "symlink" && (await c.o.fs.realpath(c.oldRoot)) === (await c.o.fs.realpath(c.newRoot));

/** 数据已离开 from(没了,或只剩本迁移的别名)且完整落在 to */
async function moved(c: Ctx, from: string, to: string): Promise<boolean> {
  const src = await c.o.fs.lstat(from);
  const gone = src === null || (from === c.oldRoot && (await isAlias(c)));
  return gone && (await holdsData(c, to));
}

/** 把数据根 from 整个改名到 to;to 只允许不存在或(迁移方向)是空目录 */
function moveStep(id: string, from: (c: Ctx) => string, to: (c: Ctx) => string, recovery: string): TxStep<Ctx> {
  return {
    id, item: STATE_ITEM, recovery,
    read: async (c) => ({ from: from(c), to: to(c), identity: c.identity, ...c.owner, emptyNewMode: id === "state-move" ? c.emptyNewMode : null }),
    conflicts: async (c) => c.problems,
    done: async (c) => moved(c, from(c), to(c)),
    apply: async (c) => {
      await guardWrite(c, { from: from(c), to: to(c) });
      if (!(await holdsData(c, from(c)))) throw new Error("数据根的身份 / 属主和开始时不一致,停下");
      await c.o.fs.rename(from(c), to(c));
    },
    verify: async (c) => moved(c, from(c), to(c)),
    compensate: async (c, before) => {
      // 用日志里的身份核对:续跑时两个根可能已是冲突形态,本次运行算不出身份
      const b = before as { identity: string; emptyNewMode: number | null };
      const src = await c.o.fs.lstat(from(c));
      if (!(await hasIdentity(c, to(c), b.identity))) {
        if (src?.kind === "dir") return; // 改名没发生(或已经搬回)
        throw new Error("两个根都找不到原身份的数据,需人工核查");
      }
      // 原路径上冒出了别的目录 / 文件(搬迁窗口里有写者重建了根):两边都不能动,留日志等人
      if (src) throw new Error("原路径被别的东西占了(可能是搬迁窗口里新建的根),不覆盖,需人工核查");
      await guardWrite(c, { from: to(c), to: from(c) });
      await c.o.fs.rename(to(c), from(c));
      if (b.emptyNewMode !== null) await c.o.fs.mkdir(to(c), b.emptyNewMode);
    },
  };
}

const aliasStep: TxStep<Ctx> = {
  id: "state-alias", item: STATE_ITEM, recovery: "删掉旧路径上指向新根的 symlink",
  read: async (c) => ({ link: c.oldRoot, target: c.newRoot }),
  conflicts: async () => [],
  done: isAlias,
  apply: async (c) => {
    await guardWrite(c);
    await c.o.fs.symlink(c.newRoot, c.oldRoot);
  },
  verify: async (c) => (await isAlias(c)) && (await holdsData(c, c.newRoot)) && (await readIdentity(c.o.fs, c.oldRoot)).ok,
  compensate: async (c) => {
    if (!(await isAlias(c))) return;
    await guardWrite(c);
    await c.o.fs.unlink(c.oldRoot);
  },
};

const unaliasStep: TxStep<Ctx> = {
  id: "state-unalias", item: STATE_ITEM, recovery: "在旧路径重建指向新根的 symlink",
  read: async (c) => ({ link: c.oldRoot, target: c.newRoot, identity: c.identity, ...c.owner }),
  conflicts: async (c) => c.problems,
  done: async (c) => (await c.o.fs.lstat(c.oldRoot)) === null || (await holdsData(c, c.oldRoot)),
  apply: async (c) => {
    await guardWrite(c);
    if (!(await isAlias(c))) throw new Error("旧路径不是本迁移建的别名,不删");
    await c.o.fs.unlink(c.oldRoot);
  },
  verify: async (c) => (await c.o.fs.lstat(c.oldRoot))?.kind !== "symlink",
  compensate: async (c) => {
    // 只看形态不看身份:续跑时本次可能算不出身份,而旧路径空着、新根是目录时重建别名总是回到删除前
    if ((await c.o.fs.lstat(c.oldRoot)) !== null || (await c.o.fs.lstat(c.newRoot))?.kind !== "dir") return;
    await guardWrite(c);
    await c.o.fs.symlink(c.newRoot, c.oldRoot);
  },
};

const STEPS: Record<Direction, TxStep<Ctx>[]> = {
  migrate: [moveStep("state-move", (c) => c.oldRoot, (c) => c.newRoot, "把新根改名回旧根(空新根则重建空目录)"), aliasStep],
  rollback: [unaliasStep, moveStep("state-return", (c) => c.newRoot, (c) => c.oldRoot, "把旧根改名回新根")],
};

const EXPECT: Record<Direction, Layout["kind"]> = { migrate: "migrated", rollback: "legacy" };

type Action = "run" | "recover";

const refusedReport = (o: StateMigrationOptions, mode: TxMode, error: string, layout: StateReport["layout"]): StateReport =>
  ({ txId: o.txId, mode, status: "refused", steps: [], error, layout });

/**
 * 有日志就以日志里的锚为准:某个根(普通目录)必须仍持有锚里的身份与属主 / 权限,否则整次拒绝、不动任何根。
 * 新根冒出别的身份(搬迁窗口里被重建)不影响:锚在哪个根就按哪个根续,补偿时再拒绝覆盖。
 */
async function bindAnchor(ctx: Ctx, dir: Direction): Promise<string | null> {
  const a = await journalAnchor(ctx.o.journalDir, ctx.o.txId, STEPS[dir].map((s) => s.id));
  if (a.kind === "none") return null;
  if (a.kind === "bad") return a.error;
  Object.assign(ctx, { identity: a.anchor.identity, owner: { mode: a.anchor.mode, uid: a.anchor.uid, gid: a.anchor.gid } });
  for (const root of [ctx.oldRoot, ctx.newRoot]) if (await holdsData(ctx, root)) return null;
  return "续跑时两个根都没有事务开始时的身份 / 属主(中断后被换过或数据丢了),拒绝继续,日志保留待人工核查";
}

async function run(o: StateMigrationOptions, dir: Direction, action: Action): Promise<StateReport> {
  const mode: TxMode = parseTxMode(o.mode);
  if (mode === "off") return { txId: o.txId, mode, status: "off", steps: [], layout: "unchecked" };
  const rootIssues = await rootProblems(o);
  // 输入本身不合法(自定义根未批准等)时连续跑也不做:续跑不再过冲突检查
  if (mode === "on" && rootIssues.length) return refusedReport(o, mode, rootIssues.join(";"), "unchecked");
  const ctx = await prepare(o, dir, rootIssues);
  const anchorIssue = mode === "on" ? await bindAnchor(ctx, dir) : null;
  if (anchorIssue) return refusedReport(o, mode, anchorIssue, ctx.layout.kind);
  const tx = {
    txId: o.txId, mode, items: { [STATE_ITEM]: mode }, steps: STEPS[dir], adapter: ctx,
    stateDir: o.journalDir, crashAt: o.crashAt, lockWaitMs: o.lockWaitMs,
  };
  const report = action === "run" ? await runTransaction<Ctx>(tx) : await rollbackTransaction<Ctx>(tx);
  const after = await inspectLayout(o.fs, ctx.oldRoot, ctx.newRoot);
  // 同一 txId 的已提交日志会让执行器直接回报 committed;磁盘形态对不上就不能说成功
  if (report.status === "committed" && after.kind !== EXPECT[dir]) {
    return { ...report, status: "refused", error: `事务 ${o.txId} 早已提交,但两个根现在是 ${after.kind};换新 txId 重新检查`, layout: after.kind };
  }
  return { ...report, layout: after.kind };
}

/** 旧根 → 新根 + 旧路径别名 */
export const migrateState = (o: StateMigrationOptions): Promise<StateReport> => run(o, "migrate", "run");

/** 撤别名 + 当前完整数据搬回旧根;不用任何迁移前快照 */
export const rollbackState = (o: StateMigrationOptions): Promise<StateReport> => run(o, "rollback", "run");

/**
 * 续补偿:事务停在 rollback_failed(补偿时写者未停等)或中断在执行中,写者停下后用同一 txId 调它,
 * 逆序撤掉该事务已做的步骤。direction 是当初那次事务的方向(migrateState → "migrate")。
 */
export const recoverState = (o: StateMigrationOptions, direction: Direction): Promise<StateReport> => run(o, direction, "recover");

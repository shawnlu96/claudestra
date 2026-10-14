/**
 * rename.state:保留身份地把状态根整个改名到新根,旧路径留 symlink 别名;回滚把**当前**完整数据搬回旧路径并撤别名。
 * 只有同文件系统的原子 rename,不复制、不合并、不生成身份:新根为空时旧根改名盖过空目录,反方向(空根盖旧根)不存在。
 * off 不碰磁盘;observe 只读出计划与冲突(不建日志和锁);on 走事务执行器,中断后同一 txId 重跑即续上。
 * tests/floka-state.test.ts。
 */

import { resolve } from "path";
import { parseTxMode, runTransaction } from "../transaction/executor.ts";
import type { TxMode, TxStep } from "../transaction/types.ts";
import {
  dataRoot, deviceProblem, inspectLayout, readIdentity, rootProblems, sameOwner, writerProblem,
} from "./layout.ts";
import type { Layout, NodeStat, StateMigrationOptions, StateReport } from "./types.ts";

const STATE_ITEM = "rename.state";

type Direction = "migrate" | "rollback";

interface Ctx {
  o: StateMigrationOptions;
  oldRoot: string;
  newRoot: string;
  /** 本次运行开始时数据根的身份摘要与根目录属主 / 权限;每一步都拿它核对 */
  identity: string;
  rootStat: NodeStat | null;
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
  const ctx: Ctx = { o, oldRoot, newRoot, identity: "", rootStat: null, emptyNewMode: null, layout, problems: [...rootIssues] };
  const problems = ctx.problems;
  if (layout.kind === "legacy" && layout.newEmptyDir) ctx.emptyNewMode = (await o.fs.lstat(newRoot))?.mode ?? null;
  if (layout.kind === "conflict") return problems.push(...layout.reasons), ctx;
  if (layout.kind === "missing") return problems.push("旧根和新根都不存在"), ctx;
  const root = dataRoot(layout, oldRoot, newRoot)!;
  const id = await readIdentity(o.fs, root);
  if (id.ok) ctx.identity = id.sum;
  else problems.push(`${id.problem}(${root === oldRoot ? "旧根" : "新根"}),拒绝迁移,也不会生成新身份`);
  ctx.rootStat = await o.fs.lstat(root);
  if (dir === "rollback" && layout.kind === "legacy") problems.push("数据还在旧根,没有可回滚的迁移");
  const dev = await deviceProblem(o.fs, root, root === oldRoot ? newRoot : oldRoot);
  if (dev) problems.push(dev);
  const w = await writerProblem(o);
  if (w) problems.push(w);
  return ctx;
}

/** 动手前的最后一道:写者仍须全停、设备仍须相同。中断后续跑不再走冲突检查,所以每个 apply 都要自己再问 */
async function guardWrite(c: Ctx, from: string, to: string): Promise<void> {
  const problem = (await writerProblem(c.o)) ?? (await deviceProblem(c.o.fs, from, to));
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
  return (await hasIdentity(c, root, c.identity)) && sameOwner(await c.o.fs.lstat(root), c.rootStat);
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
    read: async (c) => ({ from: from(c), to: to(c), identity: c.identity, emptyNewMode: id === "state-move" ? c.emptyNewMode : null }),
    conflicts: async (c) => c.problems,
    done: async (c) => moved(c, from(c), to(c)),
    apply: async (c) => {
      await guardWrite(c, from(c), to(c));
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
    await guardWrite(c, c.newRoot, c.oldRoot);
    await c.o.fs.symlink(c.newRoot, c.oldRoot);
  },
  verify: async (c) => (await isAlias(c)) && (await holdsData(c, c.newRoot)) && (await readIdentity(c.o.fs, c.oldRoot)).ok,
  compensate: async (c) => {
    if (await isAlias(c)) await c.o.fs.unlink(c.oldRoot);
  },
};

const unaliasStep: TxStep<Ctx> = {
  id: "state-unalias", item: STATE_ITEM, recovery: "在旧路径重建指向新根的 symlink",
  read: async (c) => ({ link: c.oldRoot, target: c.newRoot }),
  conflicts: async (c) => c.problems,
  done: async (c) => (await c.o.fs.lstat(c.oldRoot)) === null || (await holdsData(c, c.oldRoot)),
  apply: async (c) => {
    await guardWrite(c, c.newRoot, c.oldRoot);
    if (!(await isAlias(c))) throw new Error("旧路径不是本迁移建的别名,不删");
    await c.o.fs.unlink(c.oldRoot);
  },
  verify: async (c) => (await c.o.fs.lstat(c.oldRoot))?.kind !== "symlink",
  compensate: async (c) => {
    // 只看形态不看身份:续跑时本次可能算不出身份,而旧路径空着、新根是目录时重建别名总是回到删除前
    if ((await c.o.fs.lstat(c.oldRoot)) === null && (await c.o.fs.lstat(c.newRoot))?.kind === "dir") await c.o.fs.symlink(c.newRoot, c.oldRoot);
  },
};

const STEPS: Record<Direction, TxStep<Ctx>[]> = {
  migrate: [moveStep("state-move", (c) => c.oldRoot, (c) => c.newRoot, "把新根改名回旧根(空新根则重建空目录)"), aliasStep],
  rollback: [unaliasStep, moveStep("state-return", (c) => c.newRoot, (c) => c.oldRoot, "把旧根改名回新根")],
};

const EXPECT: Record<Direction, Layout["kind"]> = { migrate: "migrated", rollback: "legacy" };

async function run(o: StateMigrationOptions, dir: Direction): Promise<StateReport> {
  const mode: TxMode = parseTxMode(o.mode);
  if (mode === "off") return { txId: o.txId, mode, status: "off", steps: [], layout: "unchecked" };
  const rootIssues = await rootProblems(o);
  // 输入本身不合法(自定义根未批准等)时连续跑也不做:续跑不再过冲突检查
  if (mode === "on" && rootIssues.length) return { txId: o.txId, mode, status: "refused", steps: [], error: rootIssues.join(";"), layout: "unchecked" };
  const ctx = await prepare(o, dir, rootIssues);
  const report = await runTransaction<Ctx>({
    txId: o.txId, mode, items: { [STATE_ITEM]: mode }, steps: STEPS[dir], adapter: ctx,
    stateDir: o.journalDir, crashAt: o.crashAt, lockWaitMs: o.lockWaitMs,
  });
  const after = await inspectLayout(o.fs, ctx.oldRoot, ctx.newRoot);
  // 同一 txId 的已提交日志会让执行器直接回报 committed;磁盘形态对不上就不能说成功
  if (report.status === "committed" && after.kind !== EXPECT[dir]) {
    return { ...report, status: "refused", error: `事务 ${o.txId} 早已提交,但两个根现在是 ${after.kind};换新 txId 重新检查`, layout: after.kind };
  }
  return { ...report, layout: after.kind };
}

/** 旧根 → 新根 + 旧路径别名 */
export const migrateState = (o: StateMigrationOptions): Promise<StateReport> => run(o, "migrate");

/** 撤别名 + 当前完整数据搬回旧根;不用任何迁移前快照 */
export const rollbackState = (o: StateMigrationOptions): Promise<StateReport> => run(o, "rollback");

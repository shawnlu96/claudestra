/**
 * runtime 别名的执行与回滚(rename.runtime)。on 只做一件事:在别名路径建一条指向现存 runtime 真实目录的软链,
 * 建完经别名再查一次 server 身份,和建之前不一样就撤掉并拒绝。不复制 socket、不启动 tmux、不建第二套 master;
 * socket 物理落点的切换只在计划的 maintenance 里输出。回滚 / 撤销只删核对过的那一条软链:先原子取走再核对,不是就放回(见 take.ts),别的一概不碰。
 */

import { isAbsolute, resolve } from "path";
import { parseTxMode } from "../transaction/executor.ts";
import type { Json, TxStep } from "../transaction/types.ts";
import { planRuntimeAlias, socketIdentity } from "./plan.ts";
import { unlinkOwned } from "./take.ts";
import type { AliasFs, EntryHold, Refusal, RuntimeAliasInput, RuntimeAliasPlan, RuntimeAliasReport } from "./types.ts";

export { planRuntimeAlias } from "./plan.ts";

/** 分项开关名,也是事务步骤的 item */
export const RUNTIME_ITEM = "rename.runtime";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const refused = (plan: RuntimeAliasPlan | undefined, refusals: Refusal[], changed = false): RuntimeAliasReport => ({
  mode: "on", status: "refused", changed, refusals, ...(plan ? { plan, identityBefore: plan.identity } : {}),
});

/** 按开关执行:off 什么都不读,observe 只出计划,on 建别名(已在则不动)。拒绝以报告返回,不抛 */
export async function applyRuntimeAlias(i: RuntimeAliasInput): Promise<RuntimeAliasReport> {
  const mode = parseTxMode(i.mode);
  if (mode === "off") return { mode, status: "off", changed: false };
  const plan = await planRuntimeAlias(i);
  if (mode === "observe") return { mode, status: "observed", changed: false, plan, identityBefore: plan.identity, refusals: plan.refusals };
  if (plan.refusals.length) return refused(plan, plan.refusals);
  const create = plan.action === "create-alias";
  let mine: EntryHold | null = null;
  if (create) {
    try {
      await i.fs.symlink(plan.currentReal, plan.aliasDir);
      mine = await i.fs.hold(plan.aliasDir);
    } catch (e) {
      return refused(plan, [{ code: "conflict-entry", scope: "alias", detail: `建别名失败(可能刚被别人占用):${errText(e)}` }]);
    }
  }
  try {
    return await verifyAlias(i, plan, create, mine?.id ?? null);
  } finally {
    await mine?.release();
  }
}

/** 建完(或已在)经别名再查 server 身份;对不上就撤掉本次建的那条(mine = 建完时的标识)并拒绝 */
async function verifyAlias(i: RuntimeAliasInput, plan: RuntimeAliasPlan, create: boolean, mine: string | null): Promise<RuntimeAliasReport> {
  const after = await socketIdentity(i, plan.aliasDir);
  if (after !== plan.identity) {
    const cleanup = create ? (await unlinkOwned(i.fs, plan.aliasDir, plan.currentReal, mine)).refusal : undefined;
    const undo = !create ? "" : cleanup ? ",本次建过别名但没有撤掉(见下一条)" : ",已撤掉本次建的别名";
    const detail = `经别名看到的 server 身份与现路径不一致(${after ?? "查不到"} ≠ ${plan.identity})${undo}`;
    const refusals: Refusal[] = [{ code: "identity-mismatch", scope: "server", detail }, ...(cleanup ? [cleanup] : [])];
    return { ...refused(plan, refusals, create), identityAfter: after };
  }
  return { mode: "on", status: create ? "aliased" : "already", changed: create, plan, identityBefore: plan.identity, identityAfter: after };
}

/**
 * 回滚:去掉别名,路径解析回到只有现存 runtime 目录。别名不在就是无事可做(幂等);
 * 别名位置是真实目录 / 指向别处 / 失效软链时不是本库建的,拒绝且不碰。server 连不上不拦回滚,但回滚前后身份必须相同。
 * 计划前先占住并记下别名这一项的标识(占住期间 inode 号不会被后来者复用),删时按 take.ts 先取走再核:期间任何时刻被换掉都拒绝,替代项放回原位。
 */
export async function rollbackRuntimeAlias(i: RuntimeAliasInput): Promise<RuntimeAliasReport> {
  if (parseTxMode(i.mode) !== "on") {
    return refused(undefined, [{ code: "mode-not-on", scope: "path", detail: `${RUNTIME_ITEM} 不是 on,不回滚` }]);
  }
  // 入参不成立时 planRuntimeAlias 会拒绝,这里只是不去 lstat 非法路径
  const entry = typeof i.aliasDir === "string" && isAbsolute(i.aliasDir) ? await i.fs.hold(resolve(i.aliasDir)) : null;
  try {
    return await rollbackHeld(i, entry?.id ?? null);
  } finally {
    await entry?.release();
  }
}

async function rollbackHeld(i: RuntimeAliasInput, entry: string | null): Promise<RuntimeAliasReport> {
  const plan = await planRuntimeAlias(i);
  const blocking = plan.refusals.filter((r) => r.scope !== "server");
  if (blocking.length) return refused(plan, blocking);
  if (plan.aliasState === "absent") return { mode: "on", status: "absent", changed: false, plan, identityBefore: plan.identity, identityAfter: plan.identity };
  const gone = await unlinkOwned(i.fs, plan.aliasDir, plan.currentReal, entry);
  if (gone.refusal) return refused(plan, [gone.refusal], gone.changed);
  const after = await socketIdentity(i, plan.currentDir);
  if (after !== plan.identity) {
    const detail = `别名已去掉,但现路径上的 server 身份在回滚期间变了(${plan.identity ?? "查不到"} → ${after ?? "查不到"})`;
    return { ...refused(plan, [{ code: "identity-mismatch", scope: "server", detail }], true), identityAfter: after };
  }
  return { mode: "on", status: "rolled_back", changed: true, plan, identityBefore: plan.identity, identityAfter: after };
}

const must = (r: RuntimeAliasReport): void => {
  if (r.status === "refused") throw new Error((r.refusals ?? []).map((x) => `${x.code}:${x.detail}`).join(";") || "被拒绝");
};

/**
 * 接到通用迁移事务(transaction/executor.ts)里的一步。旧值只记别名原先在不在:
 * 原先就有的别名补偿时保留,本步建的才删。
 */
export function runtimeAliasStep(input: Omit<RuntimeAliasInput, "mode">): TxStep<unknown> {
  const i: RuntimeAliasInput = { ...input, mode: "on" };
  return {
    id: "runtime.alias",
    item: RUNTIME_ITEM,
    recovery: `去掉别名 ${input.aliasDir}(只删指向 ${input.currentDir} 的软链)`,
    read: async () => {
      const p = await planRuntimeAlias(i);
      return { aliasState: p.aliasState, identity: p.identity, refusals: p.refusals.map((r) => `${r.code}:${r.detail}`) };
    },
    conflicts: async (_a, before) => (before as { refusals: string[] }).refusals,
    done: async () => (await planRuntimeAlias(i)).aliasState === "aliased",
    apply: async () => must(await applyRuntimeAlias(i)),
    verify: async () => {
      const p = await planRuntimeAlias(i);
      return p.aliasState === "aliased" && p.identity !== null && (await socketIdentity(i, p.aliasDir)) === p.identity;
    },
    compensate: async (_a, before: Json) => {
      if ((before as { aliasState: string }).aliasState === "absent") must(await rollbackRuntimeAlias(i));
    },
  };
}

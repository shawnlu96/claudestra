/**
 * 续跑的身份锚:事务第一步记进日志的身份摘要与根的属主 / 权限。
 * 续跑时执行器不再过冲突检查,如果拿「此刻磁盘上读到的身份」当基准,中断后被换掉的身份会被当成原身份继续搬。
 * 所以有日志时一律以日志里的为准,对不上就整次拒绝,不动任何一个根。tests/floka-state.test.ts「续跑身份」。
 */

import { loadJournal } from "../transaction/journal.ts";
import type { NodeStat } from "./types.ts";

export type Owner = Pick<NodeStat, "mode" | "uid" | "gid">;
export interface Anchor extends Owner { identity: string }

const isAnchor = (v: unknown): v is Anchor => {
  const a = v as Partial<Anchor> | null;
  return !!a && typeof a.identity === "string" && a.identity.length > 0
    && [a.mode, a.uid, a.gid].every((n) => typeof n === "number" && Number.isInteger(n));
};

/**
 * 读日志里的锚。没有日志 / 还没记下任何一步 → none(新事务,按此刻磁盘准备);
 * 日志本身坏了交给执行器拒绝(它会报具体原因),这里也按 none;记录了步骤却读不出锚 → bad。
 */
export async function journalAnchor(journalDir: string, txId: string, plan: string[]): Promise<{ kind: "none" } | { kind: "bad"; error: string } | { kind: "ok"; anchor: Anchor }> {
  const load = await loadJournal(journalDir, txId, plan);
  if (load.kind !== "ok" || !load.journal.steps.length) return { kind: "none" };
  const before = load.journal.steps[0]!.before as Partial<Anchor> | null;
  const anchor = before && { identity: before.identity, mode: before.mode, uid: before.uid, gid: before.gid };
  return isAnchor(anchor) ? { kind: "ok", anchor } : { kind: "bad", error: "事务日志里没有可核对的身份锚,拒绝续跑" };
}

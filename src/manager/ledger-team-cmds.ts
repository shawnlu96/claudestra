/**
 * `ledger team-apply <提案 id>`：编排班子提案（lib/team-proposal.ts）落进台账的唯一入口。
 * owner 在界面上点确认 → bridge 把提案标成 confirmed → 用 runManager 调这条命令；这里再核对一遍
 * （已确认、参数哈希一致、确认时未过期、没超出执行窗口），三项都满足才写 PM 名单、班子配置和一条 owner 决定。
 * 核对与写入都在提案文件的锁里：同一份提案只能写一次（双击、重放都拿到「状态是 applied」）。
 * 这是产品约束，不是安全边界：同一用户的进程能直接改提案文件伪造 confirmed（docs/team/orchestration-team.md）。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { appendEvent, setMeta } from "../lib/ledger-write.js";
import { applyRefusal, ledgerWrites, updateProposals, type TeamProposal } from "../lib/team-proposal.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 三处写入各带固定 dedupKey：万一写到一半进程被杀，同一提案的残留不会被别的写入冒名顶替 */
function writeLedger(c: LedgerCli, p: TeamProposal, now: number): void {
  const w = ledgerWrites(p);
  const ctx = (part: string) => ({ actor: c.deps.actor, now, dedupKey: `team-apply:${p.id}:${part}` });
  setMeta(c.db, ctx("pms"), { project: p.project, key: "pms", value: w.pms });
  if (w.team !== undefined) setMeta(c.db, ctx("team"), { project: p.project, key: "team", value: w.team });
  appendEvent(c.db, ctx("decision"), { project: p.project, target: "", kind: "decision", text: w.decision, data: { transcribed: true, proposal: p.id } });
}

async function teamApply(c: LedgerCli): Promise<Result> {
  const id = c.p.pos[1];
  if (!id) throw new LedgerError("invalid", "缺提案 id");
  // bridge 经 runManager 调用时没有频道号，身份就是 owner；agent 会话里跑一律拒绝
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", `team-apply 只在 owner 点确认后由 bridge 调用（你是 ${c.deps.actor}）`);
  const now = c.deps.now();
  const r = await updateProposals((all): Result => {
    const p = all[id];
    const why = applyRefusal(p, now);
    if (why || !p) return { ok: false, code: "forbidden", error: why ?? "提案不存在" };
    try {
      writeLedger(c, p, now);
    } catch (e) {
      p.status = "failed";
      p.note = `${p.note ?? ""}；写台账失败：${(e as Error).message}`;
      return { ok: false, code: e instanceof LedgerError ? e.code : "invalid", error: p.note };
    }
    p.status = "applied";
    return { ok: true, proposal: id, kind: p.kind, project: p.project, pms: p.pms };
  }, now, c.deps.proposals?.path);
  if (r.ok === false) throw new LedgerError(r.code as LedgerError["code"], String(r.error));
  return r;
}

export const TEAM_CMDS: Record<string, CommandSpec> = {
  "team-apply": { valued: [], usage: "team-apply <提案 id>（只由 bridge 在 owner 点确认后调用）", run: teamApply },
};

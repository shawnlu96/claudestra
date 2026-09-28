/**
 * `ledger team-apply <提案 id>`：编排班子提案（lib/team-proposal.ts）落进台账的唯一入口。
 * owner 在界面上点确认 → bridge 把提案标成 confirmed → 用 runManager 调这条命令；这里再核对一遍
 * （已确认、内容哈希一致、确认时未过期、没超出执行窗口、提议时的 PM 名单与班子配置没变），都满足才在一个事务里写
 * PM 名单、班子配置和一条 owner 决定。`--check` 只核对不写：bridge 在建调度助理之前先跑一次，过时的提案不留下半截。
 * 核对与写入都在提案文件的锁里：同一份提案只能写一次（双击、重放都拿到「已经写进台账了」）。
 * 这是产品约束，不是安全边界：同一用户的进程能直接改提案文件伪造 confirmed（docs/team/orchestration-team.md）。
 */
import { getMeta, LedgerError } from "../lib/ledger-store.js";
import { appendEvent, setMeta } from "../lib/ledger-write.js";
import { applyRefusal, baseRefusal, ledgerWrites, teamBaseOf, updateProposals, type TeamProposal } from "../lib/team-proposal.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 三处写入同一个事务（写到一半失败不留下「名单改了、班子没改」）；各带固定 dedupKey 备查 */
function writeLedger(c: LedgerCli, p: TeamProposal, now: number): void {
  const w = ledgerWrites(p);
  const ctx = (part: string) => ({ actor: c.deps.actor, now, dedupKey: `team-apply:${p.id}:${part}` });
  c.db.transaction(() => {
    setMeta(c.db, ctx("pms"), { project: p.project, key: "pms", value: w.pms });
    if (w.team !== undefined) setMeta(c.db, ctx("team"), { project: p.project, key: "team", value: w.team });
    appendEvent(c.db, ctx("decision"), { project: p.project, target: "", kind: "decision", text: w.decision, data: { transcribed: true, proposal: p.id } });
  }).immediate();
}

async function teamApply(c: LedgerCli): Promise<Result> {
  const id = c.p.pos[1];
  if (!id) throw new LedgerError("invalid", "缺提案 id");
  // bridge 经 runManager 调用时没有频道号，身份就是 owner；agent 会话里跑一律拒绝
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", `team-apply 只在 owner 点确认后由 bridge 调用（你是 ${c.deps.actor}）`);
  const now = c.deps.now();
  const r = await updateProposals((all): Result => {
    const p = all[id];
    const why = applyRefusal(p, now) ?? (p ? baseRefusal(p, teamBaseOf(getMeta(c.db, p.project))) : null);
    if (why || !p) return { ok: false, code: "forbidden", error: why ?? "提案不存在" };
    if (c.p.bools.has("check")) return { ok: true, proposal: id, checked: true };
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
  "team-apply": { valued: [], bools: ["check"], usage: "team-apply <提案 id> [--check]（只由 bridge 在 owner 点确认后调用）", run: teamApply },
};

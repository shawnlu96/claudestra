/** 出借方 B 的台账写入：调度服务身份开逐单确认 ask、预先授权时发 inform（lib/lend-ask.ts）。台账里只有这张 ask，出借单本身记在 lend journal（lib/lend-journal.ts）。 */
import { openAskFull } from "../lib/ledger-asks.js";
import { LedgerError } from "../lib/ledger-store.js";
import { lendAskInput, lendAskProblem, lendInformText, type LendAskParams } from "../lib/lend-ask.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function params(c: LedgerCli, sub: string): LendAskParams {
  if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", `${sub} 只给调度服务用`);
  let p: unknown;
  try { p = JSON.parse(c.p.flags.params ?? ""); } catch { throw new LedgerError("invalid", "--params 要是 JSON"); }
  const bad = lendAskProblem(p);
  if (bad) throw new LedgerError("invalid", `--params 不合格：${bad}`);
  return p as LendAskParams;
}

export const LEND_ASK_CMDS: Record<string, CommandSpec> = {
  "lend-ask": {
    valued: ["params"], bools: [],
    usage: "lend-ask --params '<json>'（调度服务专用：出借单逐单确认，给 owner 开 authorize ask；同一张单只开一次）",
    run(c) {
      const r = openAskFull(c.db, lendAskInput(params(c, "lend-ask")), c.deps.now());
      return { ok: true, askId: r.ask.id, duplicate: r.existed };
    },
  },
  "lend-inform": {
    valued: ["params"], bools: [],
    usage: "lend-inform --params '<json>'（调度服务专用：预先授权期间每单通知 owner；没送到返回 notified:false，调用方不领单）",
    async run(c) {
      const text = lendInformText(params(c, "lend-inform"));
      if (!c.deps.notifyOwner) return { ok: true, notified: false, why: "这个进程没有通知通道" };
      return { ok: true, notified: await c.deps.notifyOwner(text) };
    },
  },
};

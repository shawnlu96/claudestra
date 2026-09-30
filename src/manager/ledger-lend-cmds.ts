/** 出借方 B 的台账写入：调度服务身份开逐单确认 ask（lib/lend-ask.ts）。台账里只有这张 ask，出借单本身记在 lend journal（lib/lend-journal.ts）。 */
import { openAskFull } from "../lib/ledger-asks.js";
import { LedgerError } from "../lib/ledger-store.js";
import { lendAskInput, lendAskProblem, type LendAskParams } from "../lib/lend-ask.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const LEND_CMDS: Record<string, CommandSpec> = {
  "lend-ask": {
    valued: ["params"], bools: [],
    usage: "lend-ask --params '<json>'（调度服务专用：出借单逐单确认，给 owner 开 authorize ask；同一张单只开一次）",
    run(c) {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "lend-ask 只给调度服务用");
      let params: unknown;
      try { params = JSON.parse(c.p.flags.params ?? ""); } catch { throw new LedgerError("invalid", "--params 要是 JSON"); }
      const bad = lendAskProblem(params);
      if (bad) throw new LedgerError("invalid", `--params 不合格：${bad}`);
      const r = openAskFull(c.db, lendAskInput(params as LendAskParams), c.deps.now());
      return { ok: true, askId: r.ask.id, duplicate: r.existed };
    },
  },
};

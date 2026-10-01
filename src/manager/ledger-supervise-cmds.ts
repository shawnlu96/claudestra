/** agent 监护的台账留痕（i28-S1，调度服务专用）：每次识别 / 处置写一条 note（data.op = supervise），去重键防重复动手；校验在 lib/agent-supervisor-ledger.ts。 */
import { parseSuperviseRecord, recordSupervise } from "../lib/agent-supervisor-ledger.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const SUPERVISE_CMDS: Record<string, CommandSpec> = {
  "scheduler-supervise": {
    valued: ["data"], bools: [],
    usage: "scheduler-supervise --data <json>（调度服务专用：监护的认领 / 结果，按 故障键+动作+阶段 去重；duplicate = 已经有人写过，不再动手）",
    run(c) {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "监护留痕只给调度服务写");
      let raw: unknown;
      try { raw = JSON.parse(c.need("data")); } catch (e) { throw new LedgerError("invalid", `--data 不是 JSON：${(e as Error).message}`); }
      const r = recordSupervise(c.db, { actor: c.deps.actor, now: c.deps.now() }, parseSuperviseRecord(raw));
      return { ok: true, duplicate: r.duplicate, seq: r.seq };
    },
  },
};

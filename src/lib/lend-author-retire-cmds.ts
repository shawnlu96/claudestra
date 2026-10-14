/** Scheduler writer child: never trust the service's earlier proof instead of the current transaction. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { isManager } from "./ledger-checks.js";
import { appendEvent } from "./ledger-write.js";
import { recoveryPolicy, recordObserved } from "./recovery-policy.js";
import { updateTask } from "./fix-strategy-task-write.js";
import { retireLendAuthor } from "./lend-author-retire-write.js";
import type { LendAuthorSample } from "./lend-author-retire-proof.js";

export const LEND_AUTHOR_CLI_PORTS = { transaction: tx, manager: isManager, policy: recoveryPolicy, observe: recordObserved, append: appendEvent, update: updateTask };
const LEND_AUTHOR_RETIRE = "scheduler-lend-author-retire";
interface Cli { db: Database; p: { pos: string[]; flags: Record<string, string> }; ctx(): WriteCtx }
export const LEND_AUTHOR_RETIRE_CMDS = {
  [LEND_AUTHOR_RETIRE]: {
    valued: ["rev", "spec-rev", "head", "session", "basis", "heads"], bools: [],
    usage: `${LEND_AUTHOR_RETIRE} <task> --rev N --spec-rev N --head SHA|- --session ID --heads JSON`,
    run(c: Cli): Record<string, unknown> {
      const f = c.p.flags;
      if (!/^\d+$/.test(f.rev ?? "") || !/^\d+$/.test(f["spec-rev"] ?? "") || !/^[0-9a-f]{64}$/.test(f.basis ?? "") || !f.session
        || !/^(?:[0-9a-f]{40}|-)$/.test(f.head ?? "")) throw new LedgerError("invalid", "缺 rev/spec/head/session 栅栏");
      let heads: LendAuthorSample["heads"];
      try { heads = JSON.parse(f.heads); } catch { throw new LedgerError("invalid", "heads 要 JSON 数组"); }
      if (!Array.isArray(heads) || heads.length > 100 || heads.some(h => !h || !/^[\w.-]+\/[\w.-]+$/.test(h.repo)
        || typeof h.branch !== "string" || h.branch.length > 150 || (h.head !== null && !/^[0-9a-f]{40}$/.test(h.head)))) {
        throw new LedgerError("invalid", "heads 字段不合法");
      }
      return retireLendAuthor(c.db, c.ctx(), { taskId: c.p.pos[1], rev: Number(f.rev), specRev: Number(f["spec-rev"]),
        head: f.head === "-" ? null : f.head, sessionId: f.session, basis: f.basis, heads }, LEND_AUTHOR_CLI_PORTS);
    },
  },
};

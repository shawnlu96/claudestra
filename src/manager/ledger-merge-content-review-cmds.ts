/** merge-arch-REVIEW1: the scheduler service's write for one merge-driver carry (lib/merge-content-review.ts). No external effects. */
import { LedgerError } from "../lib/ledger-store.js";
import { recordContentCarry } from "../lib/merge-content-review.js";
import type { ContentCarry } from "../lib/merge-content-review-sink.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const SHA = /^[a-f0-9]{40}$/;

/** Shape only; what the carry proves is judged inside the write transaction against the ledger as it is now. */
function carryFlag(raw: string): Omit<ContentCarry, "project" | "taskId"> {
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) { throw new LedgerError("invalid", `--carry 读不成 JSON：${(e as Error).message}`); }
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  if (typeof o.ok !== "boolean" || typeof o.reason !== "string" || ![o.oldHead, o.newHead].every((h) => typeof h === "string" && SHA.test(h))) {
    throw new LedgerError("invalid", "--carry 要有 ok、reason 和完整小写的 oldHead / newHead");
  }
  if (o.chain !== undefined && (!Array.isArray(o.chain) || o.chain.length > 16)) throw new LedgerError("invalid", "--carry 的 chain 要是 ≤16 跳的数组");
  return o as Omit<ContentCarry, "project" | "taskId">;
}

export const MERGE_CONTENT_REVIEW_CMDS: Record<string, CommandSpec> = {
  "scheduler-content-review": {
    valued: ["carry"], bools: [],
    usage: "scheduler-content-review <task> --carry <json>（调度服务：合并驱动的纯 main 沿用核对 → 内容身份证据；observe 只记观察，on 记投影，off 不记）",
    run(c) {
      const task = c.task(c.p.pos[1]), carry = carryFlag(c.need("carry"));
      c.deps.assertLease?.(); // 同步写之前再核一次调度服务租约
      return { ok: true, ...recordContentCarry(c.db, c.ctx(), { ...carry, project: task.project, taskId: task.id }) };
    },
  },
};

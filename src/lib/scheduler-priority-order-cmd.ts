/**
 * PRIO2: the scheduler service reads the ledger through a query_only handle, so the priority-order samples it queued
 * (scheduler-priority-order-record.ts) are written through this scheduler-only subcommand, in the writer's process:
 *   scheduler-priority-sample --project P --dedup priority-sort:<hash> --data <sample JSON>
 * One project-level note per dedup key; the text is rebuilt from the data so it always says what the data says.
 */
import type { Database } from "bun:sqlite";
import { LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { PRIORITY_SAMPLE_CMD, PRIORITY_SORT_OP, sampleText, type SampleData } from "./scheduler-priority-order-record.js";

const DATA_MAX = 32_000;

/** The manager's command context, structurally (src/lib never imports src/manager). */
interface SampleCli {
  db: Database; deps: { actor: string; projectIds: readonly string[] };
  p: { pos: string[]; flags: Record<string, string> };
  ctx(): WriteCtx;
}

function sampleData(raw: string | undefined): SampleData {
  if (typeof raw !== "string" || !raw || raw.length > DATA_MAX) throw new LedgerError("invalid", `要带 --data（1..${DATA_MAX} 字符的 JSON 对象）`);
  let d: unknown;
  try { d = JSON.parse(raw); } catch { throw new LedgerError("invalid", "--data 不是合法 JSON"); }
  const o = d as Partial<SampleData> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || o.op !== PRIORITY_SORT_OP || typeof o.entry !== "string"
    || !Array.isArray(o.legacy) || !Array.isArray(o.would)) {
    throw new LedgerError("invalid", `--data 要是排序样本（op=${PRIORITY_SORT_OP}，带 entry / legacy / would）`);
  }
  return o as SampleData;
}

function writePrioritySample(c: SampleCli): Record<string, unknown> {
  if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "优先级排序样本只给调度服务写");
  const f = c.p.flags, project = f.project ?? "", dedup = f.dedup ?? "";
  if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `没有项目 ${project || "（未给 --project）"}`);
  if (!/^priority-sort:[a-f0-9]{40}$/.test(dedup)) throw new LedgerError("invalid", "--dedup 要是 priority-sort:<40 位小写 hex>");
  const data = sampleData(f.data);
  const r = appendEvent(c.db, { ...c.ctx(), dedupKey: dedup }, { project, target: "", kind: "note", text: sampleText(data), data });
  return { ok: true, duplicate: r.duplicate, seq: r.event.seq };
}

export const priorityOrderCmds = {
  [PRIORITY_SAMPLE_CMD]: {
    valued: ["project", "dedup", "data"], bools: [],
    usage: `${PRIORITY_SAMPLE_CMD} --project <p> --dedup priority-sort:<hash> --data <JSON>（调度服务专用：优先级排序样本，同一 dedup 只记一次）`,
    run: writePrioritySample,
  },
};

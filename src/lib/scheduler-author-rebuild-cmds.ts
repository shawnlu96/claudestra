/**
 * AREB2: the scheduler service reads the ledger through a query_only handle (ledger-read.ts), so a rebuild's own ledger writes —
 * authorRebuild's observe event and the swap wait note — go through this scheduler-only subcommand, in the writer's process:
 *   scheduler-author-rebuild-note <task> --kind observe|wait --project P --agent A --retire-seq N [--key K --text T]
 * It re-checks the actor, the project, the card's author and LIFE1's formal retire (its seq) before writing; any mismatch is a
 * LedgerError and nothing is written. observe = recovery-policy's recordObserved, wait = the author_rebuild_wait note, both under
 * the dedup keys the in-process writes used. tests/scheduler-author-rebuild-readonly.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { recordObserved } from "./recovery-policy.js";
import { authorRetireProof } from "./scheduler-author-rebuild-proof.js";

export const AUTHOR_REBUILD_NOTE = "scheduler-author-rebuild-note";
export type RebuildNote = { kind: "observe" } | { kind: "wait"; key: string; text: string };
interface RebuildNoteInput { taskId: string; project: string; agent: string; retireSeq: number; note: RebuildNote }

/** The observe event's action text and data, as AREB1 wrote them in process. */
const observeAction = (taskId: string, agent: string, retireSeq: number) => ({
  mechanism: "authorRebuild" as const, target: taskId, actionKey: `rebuild:${retireSeq}`,
  action: `为卡 ${taskId} 重建作者（${agent} 已被生命周期正式收回，收回事件 #${retireSeq}）`, data: { agent, retireSeq },
});

function writeAuthorRebuildNote(db: Database, ctx: WriteCtx, projects: readonly string[], input: RebuildNoteInput) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "作者重建的记录只给调度服务写");
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  if (task.project !== input.project || !projects.includes(input.project)) throw new LedgerError("conflict", `卡 ${task.id} 不属于项目 ${input.project}`);
  if (task.agent !== input.agent) throw new LedgerError("conflict", `卡上执行者是 ${task.agent ?? "（无）"}，不是 ${input.agent}`);
  const proof = authorRetireProof(db, task);
  if (proof.kind !== "retired") throw new LedgerError("conflict", `没有正式收回证明：${proof.why}`);
  if (proof.agent !== input.agent || proof.retireSeq !== input.retireSeq) {
    throw new LedgerError("conflict", `收回事件是 #${proof.retireSeq}（${proof.agent}），不是 #${input.retireSeq}（${input.agent}）`);
  }
  const now = ctx.now ?? Date.now();
  if (input.note.kind === "observe") {
    const r = recordObserved(db, { project: task.project, ...observeAction(task.id, input.agent, input.retireSeq) }, now);
    return { ok: true, duplicate: !r.recorded, seq: r.seq };
  }
  const { key, text } = input.note;
  const r = appendEvent(db, { actor: "scheduler", now, dedupKey: `author-rebuild-wait:${task.id}:${input.agent}:${key}` },
    { project: task.project, target: task.id, kind: "note", text: `作者重建等待：${text}`, data: { op: "author_rebuild_wait", agent: input.agent, key } });
  return { ok: true, duplicate: r.duplicate, seq: r.event.seq };
}

/** The manager's command context, structurally (src/lib never imports src/manager). */
interface NoteCli {
  db: Database; deps: { actor: string; projectIds: readonly string[] };
  p: { pos: string[]; flags: Record<string, string> };
  ctx(): WriteCtx;
}

function noteInput(c: NoteCli): RebuildNoteInput {
  const f = c.p.flags, need = (k: string, max = 200): string => {
    const v = f[k];
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new LedgerError("invalid", `要带 --${k}（1..${max} 字符）`);
    return v;
  };
  const seq = need("retire-seq");
  if (!/^[1-9]\d{0,15}$/.test(seq)) throw new LedgerError("invalid", `--retire-seq 要是正整数，收到 ${seq}`);
  const kind = need("kind");
  if (kind !== "observe" && kind !== "wait") throw new LedgerError("invalid", `--kind 只能是 observe / wait，收到 ${kind}`);
  let note: RebuildNote = { kind: "observe" };
  if (kind === "wait") {
    const key = need("key", 40);
    if (!/^[\w-]+$/.test(key)) throw new LedgerError("invalid", `--key 只能是 [\\w-]，收到 ${key}`);
    note = { kind, key, text: need("text", 300) };
  }
  return { taskId: c.p.pos[1] ?? "", project: need("project"), agent: need("agent"), retireSeq: Number(seq), note };
}

export const AUTHOR_REBUILD_CMDS = {
  [AUTHOR_REBUILD_NOTE]: {
    valued: ["kind", "project", "agent", "retire-seq", "key", "text"], bools: [],
    usage: `${AUTHOR_REBUILD_NOTE} <task> --kind observe|wait --project <p> --agent <旧作者> --retire-seq <n> [--key <k> --text <t>]`
      + "（调度服务专用：作者重建的观察事件 / 等待说明，写前核卡、旧作者与正式收回；按原 dedup 键去重）",
    run: (c: NoteCli): Record<string, unknown> => {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "作者重建的记录只给调度服务写");
      const input = noteInput(c);
      try { return writeAuthorRebuildNote(c.db, c.ctx(), c.deps.projectIds, input); } catch (e) {
        if (e instanceof LedgerError) throw e;
        return { ok: false, code: "write_failed", error: (e as Error).message };
      }
    },
  },
};

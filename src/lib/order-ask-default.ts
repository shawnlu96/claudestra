/** Author defaults are decisions, never approvals: only explicitly nonblocking MCP asks qualify. */
import type { Database } from "bun:sqlite";
import type { CallerIdentity } from "./caller-identity.js";
import { answerAsk, getAsk, hasAsksTable, listAsks, patchAsk, type Ask } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { appendDefaultSpec, prepareDefaultSpec } from "./order-ask-default-spec.js";

export const ASK_DEFAULT_MS = 15 * 60_000;
const eligible = (a: Ask): boolean => a.extra.via === "mcp_ask" && a.blocking === false &&
  (a.extra.class === "design" || a.extra.class === "scope") && typeof a.extra.default === "string" && !!a.extra.default.trim();

/** Close first, with a durable append job in the same transaction; a restart finishes that job without choosing again. */
export function sweepAskDefaults(db: Database, now = Date.now(), publish: (ask: Ask) => void = () => {}): number {
  if (!hasAsksTable(db)) return 0;
  const ids = db.query(`SELECT id FROM asks WHERE (state = 'open' AND createdAt <= ?)
    OR (state = 'answered' AND json_extract(extra, '$.defaultAppend') = 'pending')`).all(now - ASK_DEFAULT_MS) as { id: string }[];
  let count = 0;
  for (const { id } of ids) {
    try {
      const a = db.transaction(() => {
        const cur = getAsk(db, id);
        if (!cur || !eligible(cur)) return null;
        if (cur.state === "open" && cur.createdAt + ASK_DEFAULT_MS <= now) {
          answerAsk(db, id, { choices: [], labels: [], text: "按执行者默认做法定", principal: "system:ask-default", via: "terminal", at: now, final: true });
          patchAsk(db, id, { extra: { defaultAppend: "pending", defaultAt: now } }, now);
        }
        return getAsk(db, id);
      }).immediate();
      if (!a || a.state !== "answered" || a.extra.defaultAppend !== "pending") continue;
      db.transaction(() => prepareDefaultSpec(db, getAsk(db, id)!)).immediate();
      // SQLite serializes append/recovery with other asks on the same spec; no await inside the critical section.
      db.transaction(() => {
        const cur = getAsk(db, id)!;
        if (cur.extra.defaultAppend !== "pending") return;
        appendDefaultSpec(db, cur);
        patchAsk(db, id, { extra: { defaultAppend: "done" } }, now);
      }).immediate();
      publish(getAsk(db, id)!);
      count++;
    } catch (e) {
      console.error(`⚠️ ask ${id} 自动定追加未完成，下次扫描重试：${(e as Error).message}`);
    }
  }
  return count;
}

const agentName = (s: string | null): string | null => s && (s.startsWith("agent-") || s === "master" ? s : `agent-${s}`);

/** Called only with callerOf(ws,msg).identity, never the frame's claimed fromName. No explicit id means no closure. */
export function recordDefaultPmReply(db: Database | null, who: Pick<CallerIdentity, "verified" | "agent">,
  target: unknown, body: unknown, now = Date.now()): string[] {
  if (!db || !who.verified || !who.agent || typeof target !== "string" || typeof body !== "string" || !hasAsksTable(db)) return [];
  const ids = new Set([...body.matchAll(/\bask (ask_[A-Za-z0-9]+)\b/g)].map((m) => m[1]));
  if (!ids.size) return [];
  return db.transaction(() => {
    const closed: string[] = [];
    for (const a of listAsks(db, { states: ["open"] })) {
      if (!ids.has(a.id) || !eligible(a) || agentName(a.fromAgent) !== agentName(target)) continue;
      const task = a.taskId ? getTask(db, a.taskId) : null;
      if (!task || agentName(task.pm ?? getMeta(db, task.project).pms[0] ?? null) !== agentName(who.agent)) continue;
      const step = stepAtStage(stepsOf(db, task), task);
      const executor = step?.executorKind === "agent" ? step.executor : task.agent;
      if (agentName(executor) !== agentName(target)) continue;
      answerAsk(db, a.id, { choices: [], labels: ["PM 已回复"], text: body, principal: who.agent!, via: "terminal", at: now, final: true });
      closed.push(a.id);
    }
    return closed;
  }).immediate();
}

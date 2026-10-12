/** Reserve real seats for queued finishing work; an unavailable family cannot hold other families idle. */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { PlacementFacts } from "./scheduler-placement.js";
import { placeAgentPool } from "./scheduler-agent-pool.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { heldLease } from "./ledger-lend-lease.js";
import { cardRepo } from "./card-repo.js";

/** 卡的 extra 列（JSON 文本）；坏了按空，订单 repo 回到 PR / 预留的 repo */
function extraOf(text: string): Record<string, unknown> {
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

export const FINISH_FIRST_WAIT = "空位优先留给审查 / 复验 / 修复";

export function reserveFinishing(db: Database, project: string, facts: PlacementFacts): PlacementFacts {
  const pool = facts.local.pool!;
  const reserved: PlacementFacts = { ...facts, pin: null, local: { ...facts.local,
    pool: { totals: { ...pool.totals }, running: { ...pool.running } } },
    peers: facts.peers.map((p) => ({ ...p, v2: p.v2 ? { ...p.v2, slots: { ...p.v2.slots } } : null })) };
  const queued = db.query(`SELECT t.id, t.project, t.headSHA, t.stage, t.pr, t.extra, w.authorFamily FROM tasks t JOIN task_workflows w ON w.taskId=t.id
    WHERE t.project=? AND w.mode='auto' AND t.stage IN ('review','fix') AND NOT EXISTS
    (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action IN ('review','dispatch')
    AND i.head IS t.headSHA AND i.status IN ('submitted','done'))
    ORDER BY t.createdAt, t.id`).all(project) as
    { id: string; project: string; headSHA: string | null; pr: string | null; extra: string; stage: "review" | "fix"; authorFamily: AuthorFamily }[];
  for (const task of queued) {
    const author = remoteHeadFamily(db, task) ?? task.authorFamily;
    const family = task.stage === "review" ? (author === "claude" ? "codex" : "claude") : author;
    const role = task.stage === "review" ? "reviewer" : "author";
    // A bound or creating local session already consumed its seat in localAgentPool, including re-review and fix reuse.
    if (db.query(`SELECT 1 FROM scheduler_sessions WHERE taskId=? AND role=? AND family=? AND transport!='peer' AND state!='retired'
      UNION ALL SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='ensure_session' AND status IN ('submitted','unknown')
      AND receipt LIKE ? LIMIT 1`).get(task.id, role, family, task.id, `%ensure ${role} ${family}%`)) continue;
    const placed = placeAgentPool({ ...reserved, repo: cardRepo({ pr: task.pr, extra: extraOf(task.extra) }, { repo: reserved.repo }),
      writeLeasePeer: task.stage === "fix" ? heldLease(db, task)?.peer ?? null : null }, task.stage, family);
    if (placed.kind === "local") reserved.local.pool!.running[family]++;
    if (placed.kind === "peer") {
      const peer = reserved.peers.find((p) => p.peer === placed.peer)!;
      peer.v2 = { ...peer.v2!, slots: { ...peer.v2!.slots, [family]: peer.v2!.slots[family] - 1 } };
    }
  }
  return { ...reserved, pin: facts.pin };
}

/** Keep capacity failures distinct from seats actually consumed by a finishing reservation. */
export function reservedStartPlacement(facts: PlacementFacts, reserved: PlacementFacts) {
  const placed = placeAgentPool(reserved, "write", "claude");
  return placed.kind === "wait" && placeAgentPool(facts, "write", "claude").kind !== "wait"
    ? { ...placed, reason: FINISH_FIRST_WAIT } : placed;
}

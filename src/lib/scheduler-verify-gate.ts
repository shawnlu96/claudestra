/** Scheduler verification keeps every checklist probe: deployed cards, resolved deployments, or proven peer PR imports.
 * Peer verification binds the intake, current delivery, review spec and live episode; ledger-write rechecks this gate in its transaction.
 */
import type { Database } from "bun:sqlite";
import { getTask, listEvents } from "./ledger-store.js";

/** Read only: extra.peerPr alone is never authority; require the intake's immutable event and this generation's peer delivery. */
export function peerPrVerifyKey(db: Database, taskId: string): string | null {
  const t = getTask(db, taskId), m = t?.extra.peerPr as Record<string, unknown> | undefined;
  if (!t || !m || t.kind !== "code" || !["live", "verified"].includes(t.stage) || t.assigneeKind !== "peer_agent") return null;
  const url = typeof m.url === "string" ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(m.url) : null;
  if (!url || !Number.isSafeInteger(m.number) || m.number !== Number(url[2]) || Number(url[2]) < 1 || t.pr !== m.url) return null;
  if (t.extra.repo !== undefined && t.extra.repo !== url[1]) return null;
  if (![m.peer, m.fp, m.agent, m.login].every((s) => typeof s === "string" && s.length > 0) || m.base !== "main") return null;
  if (t.assignee !== `${m.fp}/${m.agent}` || !t.headSHA || !/^[0-9a-f]{40}$/.test(t.headSHA)) return null;
  if (!db.query("SELECT 1 FROM task_workflows WHERE taskId=? AND specRev=?").get(t.id, t.specRev)) return null;
  const events = listEvents(db, { project: t.project, target: t.id });
  const born = events.find((e) => e.kind === "task" && e.data.op === "new");
  const patch = born?.data.patch as Record<string, unknown> | undefined;
  const original = (patch?.extra as Record<string, unknown> | undefined)?.peerPr as Record<string, unknown> | undefined;
  if (!born || born.dedupKey !== `peerpr:intake:${t.project}:${m.number}` || !original || patch?.assigneeKind !== "peer_agent"
    || patch.assignee !== t.assignee || patch.pr !== t.pr || patch.stage !== "spec") return null;
  if (!["peer", "fp", "agent", "login", "number", "url", "base"].every((k) => original[k] === m[k])) return null;
  const delivery = events.findLast((e) => e.kind === "deliver");
  const review = events.findLast((e) => e.kind === "stage" && e.data.to === "review");
  const live = events.findLast((e) => e.kind === "stage" && e.data.to === "live");
  if (!delivery || !review || !live || review.seq <= born.seq || delivery.seq <= review.seq || live.seq <= delivery.seq) return null;
  if (delivery.actor !== `peer:${m.peer}` || delivery.data.headSHA !== t.headSHA || delivery.data.evidence !== `${m.url}@${t.headSHA}`) return null;
  if (review.data.specRev !== t.specRev || live.data.specRev !== t.specRev || review.data.round !== t.round || delivery.data.round !== t.round || live.data.round !== t.round) return null;
  // A later binding edit must receive a fresh delivery even if a value was changed away and then back.
  if (events.some((e) => e.seq > delivery.seq && e.kind === "task" && e.data.op === "set"
    && ["headSHA", "pr", "spec", "specRev", "assignee", "assigneeKind"].some((k) => Object.hasOwn(e.data.patch ?? {}, k)))) return null;
  return `peer-pr-verify:${JSON.stringify([t.project, t.id, live.seq, t.specRev, t.headSHA])}`;
}


/** `d` resolved by a human as done (resolveDeployRun refuses the scheduler) and its intent planned on the card's current spec. */
export const RESOLVED_DONE_SQL = `d.phase='resolved' AND EXISTS (SELECT 1 FROM events AS r WHERE r.target=d.taskId AND r.kind='scheduler'
      AND r.actor<>'scheduler' AND json_extract(r.data,'$.op')='deploy_resolve' AND json_extract(r.data,'$.intentId')=d.intentId
      AND json_extract(r.data,'$.outcome')='done')
    AND EXISTS (SELECT 1 FROM scheduler_intents AS i WHERE i.id=d.intentId AND i.specRev=t.specRev)`;

const canVerify = (deploy: string, mode: string) => `SELECT 1 FROM tasks AS t
    JOIN task_workflows AS w ON w.taskId=t.id ${mode} AND w.specRev=t.specRev
    JOIN scheduler_deploys AS d ON d.taskId=t.id AND d.project=t.project AND ${deploy}
    JOIN scheduler_merges AS m ON m.intentId=d.intentId AND m.reviewedHead=t.headSHA
    WHERE t.id=? AND (t.stage='live' OR (t.stage='verified' AND ? = 'deploy-verify:' || d.intentId
      AND EXISTS (SELECT 1 FROM events AS e WHERE e.project=t.project AND e.target=t.id
        AND e.dedupKey=? AND e.kind='verify' AND e.actor='scheduler'))) LIMIT 1`;

export function schedulerCanVerify(db: Database, taskId: string, dedupKey?: string): boolean {
  const peerKey = peerPrVerifyKey(db, taskId);
  if (dedupKey?.startsWith("peer-pr-verify:") || (peerKey && dedupKey === undefined)) {
    if (!peerKey || (dedupKey !== undefined && dedupKey !== peerKey)) return false;
    return !!db.query(`SELECT 1 FROM tasks WHERE id=? AND (stage='live' OR (stage='verified' AND EXISTS
      (SELECT 1 FROM events WHERE target=? AND kind='verify' AND actor='scheduler' AND dedupKey=?)))`).get(taskId, taskId, dedupKey ?? "");
  }
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return false;
  const args = [taskId, dedupKey ?? "", dedupKey ?? ""];
  return !!db.query(canVerify("d.phase='deployed'", "AND w.mode='auto'")).get(...args) || !!db.query(canVerify(RESOLVED_DONE_SQL, "")).get(...args);
}

/** Resolve the project tree from scheduler.json; proven peer imports can use it without an automatic deploy entry. */
export function schedulerVerifyRepo(project: string, read: () => { projects: Record<string, { repoDir: string; deploy?: unknown }> }, peerPr = false): string | null {
  const p = read().projects[project];
  return p && (p.deploy || peerPr) ? p.repoDir : null;
}

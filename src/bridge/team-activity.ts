/** Read existing ledger rows and the delivery ring, without recording or probing anything new. */
import { readRegistryAgents } from "../lib/registry.js";
import { lendWorkerRows, type LendWorkerRow } from "../lib/lend-workers-view.js";
import { getMeta, listTasks, toEvent } from "../lib/ledger-store.js";
import { stepAtStage, stepsOf } from "../lib/ledger-steps.js";
import { ledgerInteractions, messageInteractions, teamIdentity, teamRingTruncated, TEAM_WINDOW_MS } from "../lib/team-activity.js";
import { activeTeamTask } from "../lib/team-tasks.js";
import { ledgerDb } from "./ledger-feed.js";
import { replayEventsSince, RING_LIMIT } from "./event-bus.js";

type RemoteInfo = Pick<LendWorkerRow, "peer" | "state" | "phase" | "beatAt">;

/** 远端执行者 / 审查员（step executor 是 worker@peer）补上远端状态；本项目有活出借单但 roles 里没有的补一行。没有远端单时 roles 原样 */
function withRemote(roles: { id: string; role: string; remote?: RemoteInfo }[], rows: LendWorkerRow[]): void {
  for (const r of rows) {
    const remote: RemoteInfo = { peer: r.peer, state: r.state, phase: r.phase, beatAt: r.beatAt };
    const hits = roles.filter((x) => x.id === r.id);
    for (const h of hits) h.remote = remote;
    if (!hits.length) roles.push({ id: r.id, role: r.role, remote });
  }
}

export async function readTeamActivity(project: string) {
  const now = Date.now();
  const agents = await readRegistryAgents();
  const names = new Set(agents.map((a) => a.name.replace(/^agent-/, "")));
  const members = new Set(agents.filter((a) => a.projectId === project).map((a) => a.name.replace(/^agent-/, "")));
  const db = ledgerDb();
  const roles: { id: string; role: string; remote?: RemoteInfo }[] = [];
  if (db) {
    for (const pm of getMeta(db, project).pms) {
      const id = teamIdentity(pm, names);
      if (id) roles.push({ id, role: "PM" });
    }
    for (const task of listTasks(db, project).filter(activeTeamTask)) {
      const step = stepAtStage(stepsOf(db, task), task);
      const id = step && teamIdentity(step.executor, names);
      if (id) roles.push({ id, role: step!.step.includes("review") ? "审查员" : "执行者" });
    }
    withRemote(roles, lendWorkerRows(db, now, project));
  }
  const rows = db?.query("SELECT * FROM events WHERE project = ? AND ts > ? AND ts <= ? ORDER BY seq DESC LIMIT 201")
    .all(project, now - TEAM_WINDOW_MS, now) as Record<string, unknown>[] | undefined;
  const ledger = ledgerInteractions((rows ?? []).slice(0, 200).map(toEvent), names, now);
  const ring = replayEventsSince(0);
  const messages = messageInteractions(ring, names, members, now);
  const all = [...ledger, ...messages].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { now, roles, interactions: all.slice(0, 200),
    truncated: (rows?.length ?? 0) > 200 || all.length > 200 || teamRingTruncated(ring, members, now, RING_LIMIT),
    gaps: ["recipient_missing", "peer_actor_instance_only", "delivery_ring_not_persistent"] };
}

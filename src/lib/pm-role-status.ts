import type { Database } from "bun:sqlite";
import { activeProjectPm, pmPointer, pmRedirect } from "./pm-role.js";
import { getMeta, listTasks } from "./ledger-store.js";
import { TERMINAL_STAGES } from "./ledger-stages.js";
import { agentInScope } from "./principals.js";
import { bareCanonicalName } from "./registry.js";
import { pmCompactRefs, type PmState } from "./pm-role-state.js";

/** Peer tokens that authorize this project's PMs; a token scoped to another project's PM is not this project's concern. */
export function projectPeerTokens(state: PmState, pms: string[]) {
  return state.principals.filter((p) => p.peer && !p.disabled && pms.some((pm) => agentInScope(p, pm)));
}

interface PmStatusEntry { location: string; value: unknown; follows: boolean; via: "pointer" | "redirect" | "manual" | "history" }
export function pmStatus(db: Database, project: string, state: PmState) {
  const active = activeProjectPm(db, project), meta = getMeta(db, project);
  const entries: PmStatusEntry[] = [];
  const reference = (location: string, name: string, redirect = true, history = false) => {
    const agent = `agent-${bareCanonicalName(name)}`;
    const covered = !!pmRedirect(db, project, agent);
    entries.push({ location, value: name, follows: history || agent === active || (redirect && covered),
      via: history ? "history" : agent === active ? "pointer" : redirect && covered ? "redirect" : "manual" });
  };
  entries.push({ location: "meta.activePm", value: pmPointer(db, project), follows: !!active, via: "pointer" });
  entries.push({ location: "meta.pms", value: meta.pms, follows: meta.pms.find((p) => p !== meta.team?.dispatcher) === active, via: "pointer" });
  for (const p of projectPeerTokens(state, meta.pms.filter((p) => p !== meta.team?.dispatcher))) {
    entries.push({ location: `peer-token:${p.id}`, value: { peer: p.peer, agents: p.agents },
      follows: !!active && agentInScope(p, active), via: "manual" });
  }
  // peers[].agent is the remote machine's agent even when it shares a local PM's name; only replyTo is this machine's PM.
  if (state.peerPrs?.project === project && typeof state.peerPrs.replyTo === "string") {
    reference("peer-prs.replyTo", state.peerPrs.replyTo.split("@")[0]!, false);
  }
  for (const [id, p] of Object.entries(state.proposals)) if (p.project === project) {
    const history = !["pending", "confirmed"].includes(p.status);
    for (const name of p.pms) if (name !== meta.team?.dispatcher) reference(`team-proposals.${id}.pms`, name, false, history);
  }
  for (const r of pmCompactRefs(state.config?.autoCompact)) {
    if (meta.pms.includes(`agent-${bareCanonicalName(r.agent)}`)) reference(r.location, r.agent, false);
  }
  for (const job of state.cron) if (job.targetAgent && meta.pms.includes(`agent-${bareCanonicalName(job.targetAgent)}`)) {
    reference(`cron.${job.id}.targetAgent`, job.targetAgent, false, !job.enabled);
  }
  for (const task of listTasks(db, project)) if (!TERMINAL_STAGES.includes(task.stage) && task.pm) reference(`tasks.${task.id}.pm`, task.pm);
  return { ok: entries.every((e) => e.follows), active, entries,
    disabledTokens: state.principals.filter((p) => p.id.startsWith("token:") && p.disabled).length };
}

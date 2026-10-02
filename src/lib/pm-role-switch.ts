import type { Database } from "bun:sqlite";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { agentInScope } from "./principals.js";
import { isPmCandidate, activeProjectPm } from "./pm-role.js";
import { pmStatus } from "./pm-role-status.js";
import { replacePmRefs, replaceCompactPmRefs, type PmState } from "./pm-role-state.js";

export interface PmSwitchDeps {
  read(): Promise<PmState>;
  online(): Promise<ReadonlySet<string>>;
  writePeerPrs(value: Record<string, unknown>): Promise<void>;
  writeConfig(value: Record<string, unknown>): Promise<void>;
  notify(target: string, text: string): Promise<void>;
  lockPath?: string;
}
interface PmChange { location: string; before: unknown; after: unknown }

function switchPlan(db: Database, project: string, agent: string, state: PmState, online: ReadonlySet<string>) {
  const meta = getMeta(db, project), old = activeProjectPm(db, project);
  const candidate = state.agents.find((a) => a.name === agent);
  const errors: string[] = [];
  if (!candidate) errors.push(`${agent} is not registered`);
  else {
    if (candidate.projectId !== project) errors.push(`${agent} belongs to another project`);
    if (!isPmCandidate(candidate) && !meta.pms.includes(agent)) errors.push(`${agent} is an executor, not a PM candidate`);
    if (!online.has(agent)) errors.push(`${agent} is offline`);
  }
  if (agent === meta.team?.dispatcher) errors.push("dispatcher cannot become active PM");
  for (const p of state.principals.filter((p) => p.peer && !p.disabled)) {
    if (!agentInScope(p, agent)) errors.push(`peer ${p.peer} token ${p.id} lacks ${agent}`);
  }
  for (const peer of state.peers.filter((p) => !p.disabled)) {
    const routes = Array.isArray(state.peerPrs?.peers) ? state.peerPrs.peers : [];
    if (!routes.some((p) => p.peer === peer.name && typeof p.agent === "string" && p.agent)) {
      errors.push(`peer ${peer.name} lacks a PM agent destination in peer-prs`);
    }
  }
  if (errors.length) throw new LedgerError("invalid", errors.join("; "));
  const former = meta.pms.filter((p) => p !== agent && p !== meta.team?.dispatcher);
  const pms = meta.pms.filter((p) => p === meta.team?.dispatcher);
  pms.push(agent, ...former);
  const changes: PmChange[] = [{ location: "meta.activePm", before: old, after: agent }, { location: "meta.pms", before: meta.pms, after: pms }];
  const peerPrs = structuredClone(state.peerPrs), config = structuredClone(state.config);
  if (peerPrs?.project === project) {
    const peers = Array.isArray(peerPrs.peers) ? peerPrs.peers : [];
    for (const r of [peerPrs, ...peers]) {
      const key = r === peerPrs ? "replyTo" : "agent", before = r[key];
      const after = replacePmRefs(before, former, agent);
      if (before !== after) {
        changes.push({ location: r === peerPrs ? "peer-prs.replyTo" : `peer-prs.peers[${peers.indexOf(r)}].agent`, before, after });
        r[key] = after;
      }
    }
  }
  if (config?.autoCompact) {
    const after = replaceCompactPmRefs(config.autoCompact, former, agent);
    if (JSON.stringify(after) !== JSON.stringify(config.autoCompact)) {
      // Only return identity diffs: config may also contain credentials and private compact instructions.
      collectChanges(config.autoCompact, after, "config.autoCompact", changes);
      config.autoCompact = after;
    }
  }
  return { old, pms, changes, peerPrs, config };
}

function collectChanges(before: unknown, after: unknown, location: string, changes: PmChange[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) before.forEach((v, i) => collectChanges(v, after[i], `${location}[${i}]`, changes));
  else if (before && after && typeof before === "object" && typeof after === "object") {
    for (const k of Object.keys(before)) collectChanges((before as any)[k], (after as any)[k], `${location}.${k}`, changes);
  } else changes.push({ location, before, after });
}

/** The pointer and PM ordering have one writer and commit with the decision in a single SQLite transaction. */
function commitPointer(db: Database, project: string, agent: string, pms: string[], actor: string, now: number) {
  return db.transaction(() => {
    for (const [key, value] of [["activePm", agent], ["pms", pms]] as const) {
      db.query("INSERT INTO meta(project,key,value) VALUES(?,?,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value")
        .run(project, key, JSON.stringify(value));
    }
    return appendEvent(db, { actor, now }, { project, target: "", kind: "decision", text: `当班 PM 改为 ${agent}`,
      data: { op: "pm-switch", activePm: agent, pms } }).event.seq;
  }).immediate();
}

export async function switchProjectPm(
  db: Database, project: string, agent: string, opts: { dryRun?: boolean; actor: string; now?: number }, deps: PmSwitchDeps,
) {
  const lock = opts.dryRun ? null : await acquireLock(deps.lockPath ?? statePath("pm-switch.lock"), 5_000);
  if (!opts.dryRun && !lock) throw new LedgerError("conflict", "PM switch is busy; retry later");
  let result;
  try {
    const state = await deps.read(), online = await deps.online();
    const plan = switchPlan(db, project, agent, state, online);
    if (opts.dryRun) return { ok: true, dryRun: true, project, agent, changes: plan.changes };
    const peerChanged = plan.changes.some((c) => c.location.startsWith("peer-prs."));
    const configChanged = plan.changes.some((c) => c.location.startsWith("config."));
    const written: ("peer" | "config")[] = [];
    let seq: number;
    try {
      if (peerChanged) { await deps.writePeerPrs(plan.peerPrs!); written.push("peer"); }
      if (configChanged) { await deps.writeConfig(plan.config!); written.push("config"); }
      seq = commitPointer(db, project, agent, plan.pms, opts.actor, opts.now ?? Date.now());
    } catch (e) {
      for (const file of written.reverse()) {
        try { if (file === "peer") await deps.writePeerPrs(state.peerPrs!); else await deps.writeConfig(state.config!); }
        catch (rollback) { console.error(`[pm-switch] rollback ${file} failed`, rollback); }
      }
      throw e;
    }
    result = { ok: true, dryRun: false, project, agent, changes: plan.changes, seq,
      status: pmStatus(db, project, { ...state, peerPrs: plan.peerPrs, config: plan.config }),
      targets: notificationTargets(state, plan.old, agent) };
  } finally { lock?.release(); }
  const notifications: { target: string; sent: boolean }[] = [];
  for (const target of result.targets) {
    try { await deps.notify(target, `当班 PM 改为 ${agent}`); notifications.push({ target, sent: true }); }
    catch (e) { console.error(`[pm-switch] notification to ${target} failed`, e); notifications.push({ target, sent: false }); }
  }
  const { targets, ...out } = result;
  return { ...out, notifications };
}

function notificationTargets(state: PmState, old: string | null, agent: string): string[] {
  const targets = new Set([agent, ...(old && old !== agent ? [old] : [])]);
  if (Array.isArray(state.peerPrs?.peers)) {
    for (const p of state.peerPrs.peers) if (state.peers.some((peer) => peer.name === p.peer && !peer.disabled)) targets.add(`${p.agent}@${p.peer}`);
  }
  return [...targets];
}

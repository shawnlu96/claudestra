import type { Database } from "bun:sqlite";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { agentInScope } from "./principals.js";
import { isPmCandidate, activeProjectPm } from "./pm-role.js";
import { pmStatus, projectPeerTokens } from "./pm-role-status.js";
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
  const former = meta.pms.filter((p) => p !== agent && p !== meta.team?.dispatcher);
  // Tokens of other projects' peers never authorize this project's PM, so they cannot block this switch.
  for (const p of projectPeerTokens(state, meta.pms.filter((p) => p !== meta.team?.dispatcher))) {
    if (!agentInScope(p, agent)) errors.push(`peer ${p.peer} token ${p.id} lacks ${agent}`);
  }
  if (state.peerPrs?.project === project) {
    const routes = Array.isArray(state.peerPrs.peers) ? state.peerPrs.peers : [];
    for (const peer of state.peers.filter((p) => !p.disabled)) {
      if (!routes.some((p) => p.peer === peer.name && typeof p.agent === "string" && p.agent)) {
        errors.push(`peer ${peer.name} lacks a PM agent destination in peer-prs`);
      }
    }
  }
  if (errors.length) throw new LedgerError("invalid", errors.join("; "));
  const pms = meta.pms.filter((p) => p === meta.team?.dispatcher);
  pms.push(agent, ...former);
  const changes: PmChange[] = [{ location: "meta.activePm", before: old, after: agent }, { location: "meta.pms", before: meta.pms, after: pms }];
  const files = pmFileEdits(project, former, agent);
  for (const file of files) for (const d of file.diff(state)) changes.push({ location: d.location, before: d.before, after: d.after });
  return { old, pms, changes, files };
}

type PmFile = "peerPrs" | "config";
interface LeafDiff { path: (string | number)[]; location: string; before: unknown; after: unknown }
interface PmFileEdit { file: PmFile; diff(state: PmState): LeafDiff[] }

/** Only this machine's PM identity fields: peer-prs peers[].agent names the remote machine's agent (peer-pr-push sends there). */
function pmFileEdits(project: string, former: string[], agent: string): PmFileEdit[] {
  return [
    { file: "peerPrs", diff: (s) => s.peerPrs?.project === project
      ? leafDiffs(s.peerPrs.replyTo, replacePmRefs(s.peerPrs.replyTo, former, agent), ["replyTo"], "peer-prs") : [] },
    // Only identity diffs are returned: config may also contain credentials and private compact instructions.
    { file: "config", diff: (s) => s.config?.autoCompact
      ? leafDiffs(s.config.autoCompact, replaceCompactPmRefs(s.config.autoCompact, former, agent), ["autoCompact"], "config") : [] },
  ];
}

function leafDiffs(before: unknown, after: unknown, path: (string | number)[], root: string): LeafDiff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) return before.flatMap((v, i) => leafDiffs(v, after[i], [...path, i], root));
  if (before && after && typeof before === "object" && typeof after === "object") {
    return Object.keys(before).flatMap((k) => leafDiffs((before as any)[k], (after as any)[k], [...path, k], root));
  }
  return [{ path, location: root + path.map((k) => typeof k === "number" ? `[${k}]` : `.${k}`).join(""), before, after }];
}

const leafAt = (value: any, path: (string | number)[]) => path.reduce((v, k) => v?.[k], value);
function setLeaf(value: any, path: (string | number)[], leaf: unknown): void {
  const parent = leafAt(value, path.slice(0, -1));
  if (parent && typeof parent === "object") parent[path.at(-1)!] = leaf;
}

/** Re-read under the switch lock and touch only the PM leaves, so another writer's unrelated fields survive. */
async function patchPmFile(deps: PmSwitchDeps, file: PmFile, diffs: (fresh: PmState) => LeafDiff[], pick: (d: LeafDiff) => unknown) {
  const fresh = await deps.read(), value = structuredClone(fresh[file]), todo = diffs(fresh);
  if (!value || !todo.length) return null;
  for (const d of todo) setLeaf(value, d.path, pick(d));
  await (file === "peerPrs" ? deps.writePeerPrs(value) : deps.writeConfig(value));
  return { value, todo };
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
    const written: { file: PmFile; value: Record<string, unknown>; todo: LeafDiff[] }[] = [];
    let seq: number;
    try {
      for (const edit of plan.files) {
        const r = await patchPmFile(deps, edit.file, edit.diff, (d) => d.after);
        if (r) written.push({ file: edit.file, ...r });
      }
      seq = commitPointer(db, project, agent, plan.pms, opts.actor, opts.now ?? Date.now());
    } catch (e) {
      for (const { file, todo } of written.reverse()) {
        // Roll back only leaves still holding our value; anything changed since belongs to its writer.
        try { await patchPmFile(deps, file, (fresh) => todo.filter((d) => JSON.stringify(leafAt(fresh[file], d.path)) === JSON.stringify(d.after)), (d) => d.before); }
        catch (rollback) { console.error(`[pm-switch] rollback ${file} failed`, rollback); }
      }
      throw e;
    }
    const after = { ...state, ...Object.fromEntries(written.map((w) => [w.file, w.value])) };
    result = { ok: true, dryRun: false, project, agent, changes: plan.changes, seq,
      status: pmStatus(db, project, after), targets: notificationTargets(state, project, plan.old, agent) };
  } finally { lock?.release(); }
  const notifications: { target: string; sent: boolean }[] = [];
  for (const target of result.targets) {
    try { await deps.notify(target, `当班 PM 改为 ${agent}`); notifications.push({ target, sent: true }); }
    catch (e) { console.error(`[pm-switch] notification to ${target} failed`, e); notifications.push({ target, sent: false }); }
  }
  const { targets, ...out } = result;
  return { ...out, notifications };
}

function notificationTargets(state: PmState, project: string, old: string | null, agent: string): string[] {
  const targets = new Set([agent, ...(old && old !== agent ? [old] : [])]);
  if (state.peerPrs?.project === project && Array.isArray(state.peerPrs.peers)) {
    for (const p of state.peerPrs.peers) if (state.peers.some((peer) => peer.name === p.peer && !peer.disabled)) targets.add(`${p.agent}@${p.peer}`);
  }
  return [...targets];
}

/**
 * S2F · S2L ports in the bridge (E1, E16 ③). A fresh central binding is assembled only from trusted home records:
 *  - the home's own lend order (`lend_orders`, same order id as the center's) for the local task, project and peer;
 *  - the center's lend view for that order (online read, cached; a miss primes it and holds this call as unavailable);
 *  - the peer registry (peers.json) for the borrower's instance id and key fingerprint;
 *  - the owner credential's signer, as the order-scoped service actor the receipts are checked against.
 * Worker JSON contributes nothing. Shared results are a fixed projection (reports, paths and self-checks stay local);
 * requestId lookups resolve through S2L's own outbox, so recovery re-asks for exactly the journaled command.
 * The center order itself is created by S2F2 (lend.create), not here.
 */
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getLendOrder } from "../lib/ledger-lend.js";
import type { LendCentralSharedResult, LendCentralTransport } from "../lib/ledger-lend-central.js";
import type { LendCentralView } from "../lib/ledger-lend-central-checks.js";
import { readPeers } from "../lib/peers.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { parseCommand, type V2Command } from "../lib/shared-ledger-contract-v2.js";
import type { Stage2Wiring } from "../lib/shared-ledger-v2-wiring.js";
import type { LendCentralJournalEntry } from "./shared-ledger-v2-lend-journal.js";

export interface LendPeer { instanceId: string; fp: string }
export interface LendBindingSources {
  wiring: Stage2Wiring;
  db(): Database | null;
  outboxDir: string;
  /** Peer registry lookup (default peers.json httpPeers); a peer without instance id and fingerprint cannot be bound. */
  peer?(name: string): Promise<LendPeer | null>;
}

const LEND_ACTIONS = ["lend.claim", "lend.renew", "lend.result"] as const;

async function registryPeer(name: string): Promise<LendPeer | null> {
  const p = ((await readPeers()).httpPeers ?? []).find((x) => x.name === name && !x.disabled);
  return p?.instanceId && p.fp ? { instanceId: p.instanceId, fp: p.fp } : null;
}

/** The outbox command a requestId was journaled under (S2L writes `{ command }` rows); null = not ours. */
export function lendCommandOf(outboxDir: string, requestId: string): V2Command | null {
  let names: string[];
  try { names = readdirSync(outboxDir).filter((n) => n.endsWith(".json")); } catch { return null; }
  for (const name of names) {
    const state = readJsonStateSync(join(outboxDir, name));
    if (state.status !== "ok") continue;
    try {
      const command = parseCommand((state.data as { command?: unknown }).command);
      if (command.requestId === requestId) return command;
    } catch { /* not an outbox row */ }
  }
  return null;
}

export function lendTransportFor(wiring: Stage2Wiring, outboxDir: string, project: string): LendCentralTransport | null {
  return wiring.transportFor(project)?.lend((id) => lendCommandOf(outboxDir, id)) ?? null;
}

export function lendBindings(src: LendBindingSources) {
  const views = new Map<string, LendCentralView>(), peers = new Map<string, LendPeer>(), priming = new Set<string>();
  const prime = (project: string, orderId: string, peerName: string) => {
    if (priming.has(orderId)) return;
    priming.add(orderId);
    void (async () => {
      const transport = lendTransportFor(src.wiring, src.outboxDir, project);
      if (!transport) return;
      const [view, peer] = await Promise.all([transport.view(orderId), (src.peer ?? registryPeer)(peerName)]);
      views.set(orderId, view as LendCentralView);
      if (peer) peers.set(peerName, peer);
    })().catch((e: Error) => console.warn(`[stage2 lend] ${orderId}: ${e.message}`)).finally(() => priming.delete(orderId));
  };

  function bindingFor(orderId: string): LendCentralJournalEntry | null {
    const d = src.db(), local = d ? getLendOrder(d, orderId) : null;
    if (!local) return null;
    const view = views.get(orderId), peer = peers.get(local.peer);
    if (!view || !peer) { prime(local.project, orderId, local.peer); return null; }
    const o = view.order, scope = src.wiring.scope(local.project), opened = src.wiring.open({ subject: "owner:self", kind: "person" }, local.project);
    if (!scope || !opened || o.projectId !== scope.projectId || o.teamId !== scope.teamId || o.taskId !== local.taskId) return null;
    if (o.executorInstanceId !== null && o.executorInstanceId !== peer.instanceId) return null;
    const signer = opened.signer;
    if (signer.instanceId !== o.homeInstanceId) return null;
    return { localProjectId: local.project, localTaskId: local.taskId, binding: {
      order: o, executorInstanceId: peer.instanceId, peer: local.peer, fp: peer.fp, homeInstanceId: o.homeInstanceId,
      worker: o.worker ?? { kind: "peer_agent", instanceId: peer.instanceId, agentId: local.peer },
      actor: { kind: "service", personId: signer.personId, instanceId: signer.instanceId, serviceId: "lend",
        representedPersonId: signer.personId, orderId: o.orderId, projects: [o.projectId], actions: [...LEND_ACTIONS] },
    } };
  }

  /** The approved projection of a result: no worker text, paths or artifacts leave the home. */
  function sharedResult(entry: LendCentralJournalEntry): LendCentralSharedResult {
    const o = entry.binding.order;
    return { summary: `出借单 ${o.orderId}（${o.step}，第 ${o.round} 轮）结果已在主场核收；报告与附件留在主场本机`, artifactIds: [] };
  }
  return { bindingFor, sharedResult };
}

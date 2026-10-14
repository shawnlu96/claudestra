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
import { centerRequestBudgetMode, budgetWouldSkip, lendBudgetVersion, lendBudgetPaused, settleLendBudget } from "../lib/center-request-budget.js";
import { schedulerV2Route } from "../lib/scheduler-v2-pass.js";
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getLendOrder } from "../lib/ledger-lend.js";
import type { LendCentralSharedResult, LendCentralTransport } from "../lib/ledger-lend-central.js";
import { publishLendWork, type LendDeps } from "../lib/lend-drive.js";
import { ensurePr, probePush, pushWork } from "../lib/lend-push.js";
import type { LendCentralView } from "../lib/ledger-lend-central-checks.js";
import { readPeers } from "../lib/peers.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { parseCommand, type V2Command } from "../lib/shared-ledger-contract-v2.js";
import type { Stage2Wiring } from "../lib/shared-ledger-v2-wiring.js";
import type { LendCentralJournalEntry } from "./shared-ledger-v2-lend-journal.js";
import type { LendCentralPublishCheck, LendCentralPublished, LendCentralPublishWork } from "./shared-ledger-v2-lend.js";

export interface LendPeer { instanceId: string; fp: string }
export interface LendBindingSources {
  wiring: Stage2Wiring;
  db(): Database | null;
  outboxDir: string;
  /** Peer registry lookup (default peers.json httpPeers); a peer without instance id and fingerprint cannot be bound. */
  peer?(name: string): Promise<LendPeer | null>;
  /** S2F6: the push / PR ports a central write delivery publishes through (default lend-push.ts). Each gets the order's check as its
   * beforeEffect, so it runs right before the push / PR command itself; publishLendWork checks again between the push and the PR. */
  push?: LendDeps["push"];
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
  const versions = new Map<string, string>();
  const prime = (project: string, orderId: string, peerName: string, version: string) => {
    if (priming.has(orderId)) return;
    priming.add(orderId);
    void (async () => {
      const transport = lendTransportFor(src.wiring, src.outboxDir, project);
      if (!transport) return;
      const [view, peer] = await Promise.all([transport.view(orderId), (src.peer ?? registryPeer)(peerName)]);
      await settleLendBudget(src.wiring.dir, orderId, version, null);
      if (versions.get(orderId) !== version) return;
      views.set(orderId, view as LendCentralView);
      if (peer) peers.set(peerName, peer);
    })().catch(async (e: Error) => {
      await settleLendBudget(src.wiring.dir, orderId, version, e);
      console.warn(`[stage2 lend] ${orderId}: center read failed`);
    }).finally(() => priming.delete(orderId));
  };

  function bindingFor(orderId: string): LendCentralJournalEntry | null {
    const d = src.db(), local = d ? getLendOrder(d, orderId) : null;
    if (!local) return null;
    const mode = centerRequestBudgetMode(local.project, src.wiring.dir);
    const localRoute = schedulerV2Route(local.taskId, d) === "local";
    if (localRoute && mode === "on") return null;
    const version = lendBudgetVersion(src.wiring, local.project, [local.taskId, local.peer]);
    if (versions.has(orderId) && versions.get(orderId) !== version) { views.delete(orderId); src.wiring.reset(); }
    versions.set(orderId, version);
    const view = views.get(orderId), peer = peers.get(local.peer);
    const wouldPrime = (!view || !peer) && !priming.has(orderId);
    if (localRoute && wouldPrime) budgetWouldSkip(mode, "lend-local");
    const pauseMode = mode === "observe" && (localRoute || !wouldPrime) ? "off" : mode;
    if (lendBudgetPaused(src.wiring.dir, orderId, version, pauseMode)) return null;
    if (!view || !peer) { prime(local.project, orderId, local.peer, version); return null; }
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
  /** The center's view of a home order read online (a journal-pinned binding never primed `views` in this process). */
  async function onlineOrder(orderId: string) {
    const d = src.db(), local = d ? getLendOrder(d, orderId) : null;
    const transport = local ? lendTransportFor(src.wiring, src.outboxDir, local.project) : null;
    return transport ? (await transport.view(orderId) as LendCentralView).order : null;
  }
  /**
   * S2F6 (E16 ①): the central delivery's publish port — the legacy push → PR pair (publishLendWork), nothing else. The order's own
   * head / round / step / PR come from the center view bindingFor already holds for this order, never from the worker. `check`
   * re-reads route, switch, order / lease view and grant before every push / PR (legacy parity: lend-publish-guard.ts).
   */
  async function publishWork(work: LendCentralPublishWork, check: LendCentralPublishCheck): Promise<LendCentralPublished> {
    const o = views.get(work.orderId)?.order ?? await onlineOrder(work.orderId);
    if (!o || o.branch !== work.branch || o.base !== work.base) return { ok: false, error: "中心订单视图读不到或与本单不符" };
    if (!work.dir) return { ok: false, error: "这张单没有工作副本" };
    const r = await publishLendWork({ target: { orderId: work.orderId, repo: work.repository, branch: work.branch, base: work.base, cloneDir: work.dir,
      orderHead: o.head, head: work.head }, pr: o.pr, taskId: work.taskId, round: o.round, step: o.step,
      summary: "中心出借单的交付：摘要与自查留在主场核收", selfCheck: "" }, src.push ?? LEND_PUSH,
      { gate: () => ({ beforeEffect: () => check() }), check: () => check() });
    return r.ok ? { ok: true, pr: r.pr } : { ok: false, error: r.reason };
  }
  return { bindingFor, sharedResult, publishWork };
}
const LEND_PUSH: LendDeps["push"] = { probe: (t) => probePush(t), work: (t, g) => pushWork(t, { beforeEffect: g?.beforeEffect }),
  pr: (p, g) => ensurePr(p, { beforeEffect: g?.beforeEffect }) };

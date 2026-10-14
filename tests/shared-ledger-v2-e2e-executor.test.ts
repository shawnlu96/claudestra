/** X15 e2e executor side: peer B's real lend loop (lend-loop / lend-drive over the tests/lend-harness.ts fakes) and 本机's real lend
 * API (sharedLendApi → openLendCentral → LedgerLendCentralClient) in front of the world's center port. Peer B's fake worker writes
 * one start record per created worker into peer B's own drill dir; drills count starts from that record, never from center
 * lend.claim lines (a restarted executor can start a worker again without claiming again).
 * This file holds no test; the e2e files import it (the world-file precedent).
 */
import { expect } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lendCommandOf } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { configureLendCentral, configureLendCentralRouting } from "../src/bridge/shared-ledger-v2-lend.js";
import { sharedLendApi } from "../src/bridge/shared-ledger-v2-lend-api.js";
import type { LendCentralBinding } from "../src/lib/ledger-lend-central-checks.js";
import type { LendOrder } from "../src/lib/ledger-lend.js";
import type { LendFile } from "../src/lib/lend-config.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { lendTick } from "../src/lib/lend-loop.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { FP, harness, sha, TEXT, wire } from "./lend-harness.js";
import { D, F, H0, lendServiceTransport, REPO, versions, type World } from "./shared-ledger-v2-e2e-world.test.js";

const START_LOG = "worker-starts.jsonl";
/** The worker starts peer B's fake worker recorded for one order (read back from its drill dir). */
export function startsOf(dir: string, orderId: string): { orderId: string; worker: string }[] {
  const path = join(dir, START_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(s => s.orderId === orderId);
}

/** The drills' check: exactly one worker start was recorded for the order (throws on zero or on a duplicate start). */
export function expectStartedOnce(dir: string, orderId: string) {
  const starts = startsOf(dir, orderId);
  expect(starts.map(s => s.orderId)).toEqual([orderId]);
  return starts[0]!;
}

/** Peer B's lend loop lending to 本机 (named "local" on peer B). `call` is 本机's lend endpoint; poll stays the harness's fake. */
export function borrower(dir: string) {
  const h = harness({ writeOpen: true, entry: { peer: "local", roles: ["review", "write"], repos: [REPO] }, peer: { name: "local" } });
  h.d.context = async () => ({ contacts: [{ name: "local", fp: FP }], projects: [] });
  const create = h.d.worker.create;
  h.d.worker.create = async (...args: Parameters<typeof create>) => {
    const made = await create(...args);
    if (made.ok) appendFileSync(join(dir, START_LOG), `${JSON.stringify({ orderId: args[4], worker: args[0] })}\n`);
    return made;
  };
  /** Ticks until the order reaches `state` (or `max` ticks ran); a restart = a fresh loop over the same journal and registry. */
  const until = async (orderId: string, state: string, max = 8) => {
    for (let i = 0; i < max && getOrder(h.db, orderId)?.state !== state; i++) await lendTick({ ...h.d });
    return getOrder(h.db, orderId)?.state;
  };
  return { h, until, restart: () => lendTick({ ...h.d }) };
}

const PEER_B = "peer-b";
/** 本机's bridge with central lend routing on for one order: binding from the center's order + peers record, grant from lend.json. */
function homeLendApi(w: World, orderId: string, local: LendOrder) {
  const outboxDir = join(w.local.dir, "lend-central"), { actor, transport } = lendServiceTransport(w, orderId);
  const order = w.k.center.rows().orders.get(orderId)!;
  const binding: LendCentralBinding = { order, executorInstanceId: PEER_B, peer: PEER_B, fp: FP, homeInstanceId: "local", actor,
    worker: { kind: "peer_agent", instanceId: PEER_B, agentId: workerName(orderId) } };
  const lend: LendFile = { version: 2, enabled: true, borrow: [], lend: [{ peer: PEER_B, fp: FP, families: { codex: 2 }, roles: ["review", "write"],
    repos: [REPO], ordersPerDay: 10, grantedAt: new Date(0).toISOString(), until: new Date(5 * 86_400_000).toISOString() }] };
  configureLendCentral({ mode: () => "on", transportFor: () => transport.lend(id => lendCommandOf(outboxDir, id)), outboxDir,
    grant: { now: () => w.k.center.time, readLend: async () => ({ status: "ok", file: structuredClone(lend) }),
      context: async () => ({ contacts: [{ name: PEER_B, fp: FP }], projects: [] }) } });
  configureLendCentralRouting({ route: () => "central", sharedResult: () => ({ summary: "主场核收", artifactIds: [] }),
    bindingFor: id => id === orderId ? { localProjectId: "project", localTaskId: local.taskId, binding } : null });
  const deps = { order: (id: string) => (id === orderId ? local : null), sign: () => ({ key: "k", sig: "s" }) };
  return async (op: string, body: Record<string, unknown>) => {
    const res = await sharedLendApi(op, JSON.stringify(body), PEER_B, deps);
    if (!res) throw new Error(`本机 lend/${op} 没走中心路由`);
    return { status: res.status, body: await res.json() };
  };
}
/** Each e2e file that wires the home lend API resets the module-level ports in afterEach. */
export function cleanupLendApi(): void { configureLendCentral(null); configureLendCentralRouting(null); }

/**
 * A write order on card T, created by 本机 on the center and claimed by peer B's real loop through 本机's lend API: the worker it
 * starts is the in-flight work of the drill. Returns the order id and the borrower to keep ticking / restarting.
 */
export async function claimedWrite(w: World, T: string) {
  w.k.center.seed({ tasks: [{ ...w.task(T), stage: "build", head: null }] });
  const branch = lendBranch(T, FP)!;
  const created = await w.local.send(w.local.cmd("lend.create", { ...versions(w, T), featureId: F, family: "codex", step: "write",
    executorInstanceId: PEER_B, specArtifactId: "artifact", head: H0, round: 0, branch, base: "main", grantId: "grant-b", grantDigest: D }));
  const orderId = created.result.entityId;
  const orderWire = { ...wire(orderId), taskId: T, node: "write", step: "write", round: 0, head: H0, repo: REPO, pr: null };
  const local = { orderId, taskId: T, project: "project", peer: PEER_B, family: "codex", step: "write", specRev: 1, round: 0, head: H0, repo: REPO,
    pr: null, wire: orderWire, text: TEXT, sha256: sha(TEXT), status: "pooled", worker: null, leaseGen: 0, leaseMs: 600_000, leaseUntil: null,
    resultSha: null, receipt: null, eventSeq: null, reason: null, supersedes: null, createdBy: "scheduler", createdAt: 0, updatedAt: 0,
    branch, base: "main" } as LendOrder;
  const api = homeLendApi(w, orderId, local), b = borrower(w.peerB.dir), poll = b.h.d.call;
  b.h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, pollAfterMs: 30_000, orders: [{ orderId, taskId: T, step: "write", family: "codex",
    repo: REPO, pr: null, head: H0, round: 0, specRev: 1, offeredAt: 1 }] } });
  b.h.d.call = async (peer, op, body) => (op === "poll" ? poll(peer, op, body) : api(op, body));
  return { orderId, b, scope: { ...V2_FIXTURE_SCOPE, orderId, taskId: T } };
}

/** Before the X13 migration the order rides the legacy lend path: peer B's real loop claims it from 本机's legacy endpoint (the
 * harness's fake answer, same wire as the home ledger row) and starts its worker. */
export async function legacyClaimed(dir: string, orderId: string, taskId: string) {
  const b = borrower(dir), preview = { orderId, taskId, step: "review", family: "codex", repo: REPO, pr: null, head: H0, round: 0, specRev: 1, offeredAt: 1 };
  b.h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [preview], pollAfterMs: 30_000 } });
  b.h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(orderId), taskId, round: 0, head: H0, repo: REPO, pr: null }, text: TEXT,
    sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
  return { b, state: await b.until(orderId, "started") };
}

/**
 * S2F6 · central lend orders in production (scheduler process). drivePool (scheduler-pool-tick.ts) asks this module first, after
 * the pool-refusal step and before `ledger scheduler-pool`:
 *  - route local (or the port not configured): null, the legacy pool step runs unchanged;
 *  - route skip: null as well (legacy path unchanged, zero center requests); under observe, one observe line per attempt key;
 *  - route central: no `ledger scheduler-pool` (S2Q answers it v2_unmapped). The lend.create body comes only from the scheduler
 *    wiring's trusted sources (cached center view: task / workflow revs, center featureId, spec artifact; S2R fence; the lender's
 *    grant from its hello; its instance id from peers.json); createLendCentralOrder sends it at most once under the home's own
 *    attempt key (lend:<card>:s<n>:r<n>:a<n>); writeLendCentralOrder then writes the home row under the center's order id.
 *  - a live central row: the sync step reads the center view online and, once claimed, projects it (projectLendCentralClaim) on
 *    a writer connection of this process (withLedgerWriter: the pass itself reads query_only). The bridge's read-only connection never writes here.
 * The home row (and a write order's lend_write_leases row) is plain SQL, and the order is rendered without forPeer's notes (no insertEvent):
 * the S2G write gate is not asked to pass anything. The offer material is journaled beside the create entry, so a replay binds the
 * center's order id only to a home row rendered from the same material (checked against the journaled head / branch / base).
 */
import type { Database } from "bun:sqlite";
import type { LendFamily } from "./lend-config.js";
import { stepOfStage, roleOfStep, remoteHeadAt, type LendStep } from "./lend-git.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { renderLendOffer, type OfferInput } from "./ledger-lend.js";
import { holdWriteLease } from "./ledger-lend-lease.js";
import type { LendCentralTransport } from "./ledger-lend-central.js";
import type { LendCentralBinding, LendCentralView } from "./ledger-lend-central-checks.js";
import { createLendCentralOrder, lendCreateRequestId, type LendCentralCreateDeps, type LendCentralCreateFields } from "./ledger-lend-central-create.js";
import { projectLendCentralClaim, writeLendCentralOrder, type LendCentralHomeOrder } from "./ledger-lend-central-home.js";
import { LendCentralOutbox } from "./ledger-lend-central-state.js";
import { V2ContractError, v2ObjectDigest, type V2Fence } from "./shared-ledger-contract-v2.js";
import type { Stage2Wiring } from "./shared-ledger-v2-wiring.js";
import { getMeta } from "./ledger-store.js";
import { getLendPeer } from "./scheduler-placement-reservations.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { orderFamily } from "./scheduler-placement-plan.js";
import { POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { cardRepo, prCoordinates } from "./card-repo.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
import { poolBorrow } from "./scheduler-agent-pool-context.js";
import { convergenceSpec } from "./fix-strategy-order.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { writeMaterials, type WriteProbe } from "./lend-write-materials.js";
import { readPeers } from "./peers.js";
import { keyFingerprint } from "./instance-key.js";
import { runBounded } from "./run-bounded.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { schedulerV2Route } from "./scheduler-v2-pass.js";
import { LEASE_MS_DEFAULT } from "./lend-wire.js";

type Route = "local" | "skip" | "central";
export interface PoolStepOut { step: string; detail: string }
/** What one central offer needs, all from trusted home records: the lend.create body and the home row under the center id. */
interface LendCentralPoolOffer {
  fields: LendCentralCreateFields;
  /** Rendered on the writer connection the home row is written with. */
  home(centerOrderId: string, writer: Database): LendCentralHomeOrder;
  /** The offer input, journaled beside the create entry before the center is asked; a replay of the attempt renders from it. */
  material?: OfferInput;
  /** A write / fix order's write lease (as offerLendCore holds it), taken with the home row so a later fix order finds it. */
  lease?: { peer: string; fp: string; branch: string; repo: string };
}
export interface LendCentralPoolPort {
  route(taskId: string): Route;
  mode(project: string): "off" | "observe" | "on";
  /** The scheduler's ledger connection (query_only in the daemon; writes open a writer on the same file); null = unavailable (held). */
  db(): Database | null;
  /** null = the trusted sources are not ready (no center view / fence / grant / materials): held, nothing asked of the center. */
  /** `saved`: the material journaled by an earlier call under this attempt key (its create entry still stands), else null. */
  offer(task: LedgerTask, intent: SchedulerIntent, attemptKey: string, pool: { maxWorkers: number; remote: RemotePolicy },
    saved: OfferInput | null): Promise<LendCentralPoolOffer | null>;
  transport(project: string): LendCentralTransport | null;
  outbox(): LendCentralOutbox;
  /** The trusted binding for projecting a claim (home row + center view + peer registry); null = not bindable yet. */
  binding?(orderId: string, view: LendCentralView): Promise<LendCentralBinding | null>;
  observe(entry: Record<string, unknown>): void;
}

let port: LendCentralPoolPort | null = null;
const observed = new Set<string>();
export function configureLendCentralPool(p: LendCentralPoolPort | null): void { port = p; observed.clear(); }

const LIVE = "status IN ('pooled','claimed','unknown')";
/** The attempt key the legacy offer would use for this card's current round (offerLendCore). */
function lendAttemptKey(db: Database, task: Pick<LedgerTask, "id" | "specRev" | "round">): string {
  const n = (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE taskId = ? AND round = ?").get(task.id, task.round) as { n: number }).n;
  return `lend:${task.id}:s${task.specRev}:r${task.round}:a${n}`;
}
const held = (detail: string): PoolStepOut => ({ step: "held", detail });
const errText = (e: unknown) => e instanceof V2ContractError ? e.code : String((e as Error)?.message ?? e);

/** drivePool's central step; null = run the legacy pool step exactly as before. */
export async function centralPoolStep(task: LedgerTask, intent: SchedulerIntent, pool: { maxWorkers: number; remote: RemotePolicy }): Promise<PoolStepOut | null> {
  const p = port;
  if (!p) return null;
  const route = p.route(task.id);
  if (route === "local") return null;
  if (route === "skip") {
    const d = p.db();
    if (d && p.mode(task.project) === "observe") {
      const key = lendAttemptKey(d, task);
      if (!observed.has(key)) { observed.add(key); p.observe({ node: "lend", taskId: task.id, attemptKey: key, code: "would_create_central_order" }); }
    }
    return null;
  }
  const d = p.db();
  if (!d) return held("台账不可用，中心出借单这一轮不出");
  const live = d.query(`SELECT orderId FROM lend_orders WHERE taskId = ? AND ${LIVE} LIMIT 1`).get(task.id) as { orderId: string } | null;
  return live ? syncClaim(p, d, task, live.orderId) : offerCentral(p, d, task, intent, pool);
}

async function offerCentral(p: LendCentralPoolPort, d: Database, task: LedgerTask, intent: SchedulerIntent,
  pool: { maxWorkers: number; remote: RemotePolicy }): Promise<PoolStepOut> {
  const key = lendAttemptKey(d, task), requestId = lendCreateRequestId(key);
  let offer: LendCentralPoolOffer | null;
  try {
    // A standing create entry (outbox, or confirmed but the home row not landed): its first material, never a newer render.
    const box = p.outbox(), saved = box.read(requestId) ? box.readMaterial(requestId) as OfferInput | null : null;
    offer = await p.offer(task, intent, key, pool, saved);
    if (offer?.material && !saved) box.saveMaterial(requestId, offer.material);
  } catch (e) { return held(`中心出借单材料没备好：${errText(e)}`); }
  if (!offer) return held("中心出借单的可信来源（中心视图 / 租约 fence / 授权 / 材料）还没齐，这一轮不出");
  const transport = p.transport(task.project);
  if (!transport) return held("中心传输未接好（unavailable）");
  const deps: LendCentralCreateDeps = { transport, outbox: () => p.outbox(), route: (id) => p.route(id) };
  try {
    const out = await createLendCentralOrder(key, offer.fields, deps);
    if (out.status === "outbox") return held(`中心暂不可达，lend.create 已记 outbox（${out.requestId}），下一轮对账`);
    if (out.status !== "confirmed") return held("路由已不是 central，中心出借单这一轮不出");
    const sent = p.outbox().read(requestId)?.command, ok = offer;
    const drift = withLedgerWriter(d, (w) => {
      const home = ok.home(out.orderId, w);
      // The center holds the journaled body: a home row rendered from other material is never bound to its order id.
      if (sent?.type !== "lend.create" || sent.payload.head !== home.head || sent.payload.branch !== home.branch || sent.payload.base !== home.base) {
        return `本机材料（head ${home.head.slice(0, 12)}）和中心单 ${out.orderId} 记的不一致`;
      }
      w.transaction(() => {
        writeLendCentralOrder(w, out.orderId, home);
        if (ok.lease) holdWriteLease(w, task, ok.lease, Date.now());
      })();
      return null;
    });
    if (drift) return held(`${drift}，本机行不写，待人工对账`);
    return { step: "pool_pooled", detail: `中心出借单 ${out.orderId}（尝试 ${key}）已挂出` };
  } catch (e) {
    return held(`中心出借单没挂出：${errText(e)}`);
  }
}

async function syncClaim(p: LendCentralPoolPort, d: Database, task: LedgerTask, orderId: string): Promise<PoolStepOut> {
  const row = d.query("SELECT status FROM lend_orders WHERE orderId = ?").get(orderId) as { status: string };
  if (row.status !== "pooled" || !p.binding) return { step: `pool_${row.status}`, detail: `中心出借单 ${orderId} ${row.status}` };
  const transport = p.transport(task.project);
  if (!transport) return held("中心传输未接好（unavailable）");
  try {
    const view = await transport.view(orderId);
    if (view.order.status !== "claimed") return { step: "pool_pooled", detail: `中心出借单 ${orderId} 还没人领` };
    const binding = await p.binding(orderId, view);
    if (!binding) return held(`中心出借单 ${orderId} 已领，绑定还没齐，下一轮回投`);
    withLedgerWriter(d, (w) => projectLendCentralClaim(w, binding, view));
    return { step: "pool_claimed", detail: `中心出借单 ${orderId} 已由 ${view.order.worker && "agentId" in view.order.worker ? view.order.worker.agentId : "?"} 领走` };
  } catch (e) {
    return held(`中心出借单 ${orderId} 回投没成：${errText(e)}`);
  }
}

/** The scheduler wiring's trusted sources (scheduler-v2-wiring.ts passes them; tests inject their own). */
export interface LendCentralPoolSources {
  wiring: Stage2Wiring;
  db(): Database | null;
  /** S2R fence of a local feature (this home holds the lease); null = not held. */
  fence(localFeatureId: string): V2Fence | null;
  instanceId(): string;
  outboxDir?: string;
  /** Default: peers.json (instance id, pinned key fingerprint) and `git ls-remote`. */
  peer?(name: string): Promise<{ instanceId: string; fp: string } | null>;
  remoteHead?: WriteProbe["remoteHead"];
  borrow?(): ReturnType<typeof readEffectiveBorrow>;
  now?(): number;
}

async function registryPeer(name: string): Promise<{ instanceId: string; fp: string } | null> {
  const r = ((await readPeers()).httpPeers ?? []).find((x) => x.name === name && !x.disabled);
  return r?.instanceId && r.publicKey ? { instanceId: r.instanceId, fp: keyFingerprint(r.publicKey) } : null;
}

/** The production port over the scheduler wiring; every field of lend.create is read from a trusted home record. */
export function lendCentralPoolPort(src: LendCentralPoolSources): LendCentralPoolPort {
  const outboxDir = src.outboxDir ?? `${src.wiring.dir}/shared-ledger-v2-lend`;
  const outbox = () => new LendCentralOutbox(outboxDir);
  const peerOf = src.peer ?? registryPeer, now = src.now ?? Date.now;
  return {
    route: (taskId) => schedulerV2Route(taskId, src.db()), // S2D's frozen rule, the only route
    mode: (project) => src.wiring.mode(project),
    db: src.db,
    transport: (project) => src.wiring.transportFor(project)?.lend((id) => outbox().read(id)?.command ?? null) ?? null,
    outbox,
    observe: (entry) => src.wiring.observe(entry),
    offer: async (task, intent, attemptKey, pool, saved) => {
      const d = src.db();
      return d ? centralOffer(src, d, task, intent, attemptKey, pool, peerOf, now(), saved) : null;
    },
    binding: async (orderId, view) => {
      const d = src.db(), row = d?.query("SELECT peer FROM lend_orders WHERE orderId = ?").get(orderId) as { peer: string } | null;
      const peer = row ? await peerOf(row.peer) : null;
      if (!row || !peer || !view.order.worker || view.order.worker.kind === "human") return null;
      const o = view.order, home = src.instanceId();
      return { order: o, worker: o.worker!, executorInstanceId: peer.instanceId, peer: row.peer, fp: peer.fp, homeInstanceId: home,
        actor: { kind: "service", personId: o.createdBy, instanceId: home, serviceId: "lend", representedPersonId: o.createdBy, orderId,
          projects: [o.projectId], actions: ["lend.claim", "lend.renew", "lend.result"] } };
    },
  };
}

async function centralOffer(src: LendCentralPoolSources, d: Database, task: LedgerTask, intent: SchedulerIntent, attemptKey: string,
  pool: { maxWorkers: number; remote: RemotePolicy }, peerOf: (n: string) => Promise<{ instanceId: string; fp: string } | null>,
  now: number, saved: OfferInput | null): Promise<LendCentralPoolOffer | null> {
  const step = stepOfStage(task.stage) as LendStep | null, ref = src.wiring.featureOfTask(d, task.id);
  if (!step || !ref || !intent.recipient?.startsWith(POOL_RECIPIENT)) return null;
  const view = src.wiring.cachedView(ref.centerFeatureId), scope = src.wiring.scope(task.project), fence = src.fence(ref.localFeatureId);
  const ct = view?.tasks.find((t) => t.id === task.id), wf = view?.workflows.find((w) => w.taskId === task.id);
  if (!view || !scope || !fence || !ct || !wf || ct.spec.artifactId === null) return null;
  const peer = intent.recipient.slice(POOL_RECIPIENT.length), role = roleOfStep(step) as "review" | "write";
  const [registry, borrows] = await Promise.all([peerOf(peer), (src.borrow ?? readEffectiveBorrow)()]);
  const grant = getLendPeer(d, peer)?.grant;
  if (!registry || !grant || grant.until <= now || !grant.roles.includes(role)) return null;
  const snap = autoSnapshot(d, task, { registry: [], maxWorkers: pool.maxWorkers, now, pool: { remote: pool.remote, borrow: borrows } }, intent.id);
  const family = orderFamily(snap, peer, role) as LendFamily | null;
  const coords = prCoordinates(task.pr), repo = role === "review" ? coords?.repo ?? null : cardRepo(task, pool.remote);
  const spec = convergenceSpec(d, task, readTextSoft(specPathFor(task, getMeta(d, task.project).docsDir)));
  if (!family || !repo || !spec || !grant.repos.includes(repo)) return null;
  // A replay renders from the journaled material: the remote base or the spec may have moved since the center order was made.
  const input = saved?.taskId === task.id && saved.peer === peer && saved.family === family && saved.repo === repo ? saved
    : await freshInput(d, task, role, { peer, family, repo, spec, fp: registry.fp, pr: coords?.pr ?? null }, src, borrows, pool);
  if (!input) return null;
  const ctx = { actor: "scheduler", now };
  // The peer gate runs before the center is asked, with forPeer's rewrites and no note: the S2G gate refuses an execution card's events.
  const first = renderLendOffer(d, ctx, task, step, attemptKey, input, { notes: false });
  const fields: LendCentralCreateFields = { teamId: scope.teamId, projectId: scope.projectId, serviceGeneration: fence.serviceGeneration,
    epoch: fence.epoch, bootId: fence.bootId, taskId: task.id, expectedRev: ct.rev, expectedSpecRev: ct.specRev, expectedWorkflowRev: wf.rev,
    featureId: ref.centerFeatureId, family, step, executorInstanceId: registry.instanceId, specArtifactId: ct.spec.artifactId, head: first.head,
    round: task.round, branch: first.made.branch, base: first.made.base, grantId: `lend-grant:${peer}:${grant.until}`, grantDigest: v2ObjectDigest(grant) };
  return {
    fields,
    material: input,
    ...(first.made.branch && input.write ? { lease: { peer, fp: input.write.fp.toLowerCase(), branch: first.made.branch, repo } } : {}),
    home: (orderId, w) => {
      const r = renderLendOffer(w, ctx, task, step, orderId, input, { notes: false });
      return { taskId: task.id, project: task.project, peer, family, step, specRev: task.specRev, round: task.round, head: r.head, repo,
        pr: input.pr, wire: r.wire as unknown as Record<string, unknown>, text: r.text, sha256: r.sha256, leaseMs: LEASE_MS_DEFAULT, createdBy: "scheduler",
        branch: r.made.branch, base: r.made.base };
    },
  };
}

async function freshInput(d: Database, task: LedgerTask, role: "review" | "write",
  o: { peer: string; family: LendFamily; repo: string; spec: string; fp: string; pr: number | null }, src: LendCentralPoolSources,
  borrows: Awaited<ReturnType<typeof readEffectiveBorrow>>, pool: { remote: RemotePolicy }): Promise<OfferInput | null> {
  const probe: WriteProbe = { peerFp: async () => o.fp, remoteHead: src.remoteHead ?? ((r, b) => remoteHeadAt(r, b, runBounded)) };
  const write = role === "write" ? await writeMaterials(d, task, { peer: o.peer, repo: o.repo, base: "main" }, probe) : null;
  if (role === "write" && !write) return null;
  return { taskId: task.id, peer: o.peer, family: o.family, repo: o.repo, pr: role === "write" ? null : o.pr, spec: o.spec,
    borrow: poolBorrow(borrows.find((b) => b.peer === o.peer) ?? null, !!pool.remote.agents), ...(write ? { write } : {}) };
}

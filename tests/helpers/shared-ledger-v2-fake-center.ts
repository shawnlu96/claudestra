/** S2C fake center: an in-memory, stateful stand-in for the V2 center behind the frozen S2K `V2_ROUTES`, for X13 / X15 / S2T tests.
 * Test fixture only — minimal semantics (receipt idempotency, epoch / lease / intent / order state, migration / revert) plus
 * fault injection (lost response after commit, 503, restart with a new bootId, serviceGeneration bump, backup restore).
 * Identity is the injected verified actor, never the body. Every served body is re-parsed by the S2K route parser.
 */
import {
  fail, parseActor, parseDTO, parseGeneration, V2_COMMAND_POLICY, V2ContractError, v2ObjectDigest,
  type V2Actor, type V2Command, type V2CommandName, type V2Feature, type V2Generation, type V2Receipt,
} from "../../src/lib/shared-ledger-contract-v2.js";
import { matchV2Route, V2_ROUTES, type V2RouteName } from "../../src/lib/shared-ledger-contract-v2-routes.js";
import { execOperationId } from "../../src/lib/shared-ledger-exec-client.js";
import { COMMAND_HANDLERS, type CommandHandler, type CommandHandlers } from "./shared-ledger-v2-fake-center-commands.js";
import {
  commandFeature, emptyState, featureView, must, receiptKey, type FakeCenterState, type FakeDag,
} from "./shared-ledger-v2-fake-center-state.js";
import { lookup, migrate, revert, type TransferContext } from "./shared-ledger-v2-fake-center-transfer.js";

export interface FakeCenterOptions {
  teamId?: string; projectId?: string;
  /** personId → team role; anyone else (or an actor without this project) is not_member. */
  roles: Record<string, "owner" | "member">;
  /** Central clock start (ms); advance with `advance()`. */
  now?: number;
  /** Extra or replacement command semantics; unmodeled commands otherwise answer conflict. */
  handlers?: CommandHandlers;
}
/** drop = the center commits, then the response never arrives; unavailable = 503 before anything is read or written. */
export interface FakeFault { kind: "drop" | "unavailable"; route?: V2RouteName; command?: V2CommandName; times?: number }
export interface FakeRequest { method: string; url: string; body?: unknown; actor: V2Actor | null }
export interface FakeResponse { status: number; body: unknown }
export interface FakeLogEntry { method: string; url: string; route: V2RouteName | null; command: V2CommandName | null; status: number | "dropped" }
/** A committed request whose response was lost (thrown by `handle`; the fetch adapter turns it into a network error). */
export class FakeCenterDropped extends Error { constructor() { super("fake center: response dropped after commit"); } }
interface Service { serviceGeneration: number; bootId: string; startedAt: number; restoredFrom: V2Generation["restoredFrom"]; boots: number }
export interface FakeCenterBackup { state: FakeCenterState; serviceGeneration: number; serverSeq: number }

export class FakeCenter {
  readonly scope: { teamId: string; projectId: string };
  readonly log: FakeLogEntry[] = [];
  time: number;
  private state = emptyState();
  private service: Service;
  private faults: (FakeFault & { left: number })[] = [];
  private readonly roles: Record<string, "owner" | "member">;
  private readonly handlers: CommandHandlers;

  constructor(options: FakeCenterOptions) {
    this.scope = { teamId: options.teamId ?? "team", projectId: options.projectId ?? "project" };
    this.roles = options.roles;
    this.time = options.now ?? 1_000_000;
    this.handlers = { ...COMMAND_HANDLERS, ...options.handlers };
    this.service = { serviceGeneration: 1, bootId: "center-boot-1", startedAt: this.time, restoredFrom: null, boots: 1 };
  }
  advance(ms: number): void { this.time += ms; }

  /** The service record a snapshot would carry; bootId changes on every restart, generation on bump / restore. */
  generation(): V2Generation {
    const s = this.service;
    return parseGeneration({ serviceId: "fake-center", serviceGeneration: s.serviceGeneration, schemaVersion: 2, bootId: s.bootId,
      state: "active", serverSeq: this.state.serverSeq, startedAt: s.startedAt, restoredFrom: s.restoredFrom,
      restoreReconciledAt: s.restoredFrom ? this.time : null });
  }
  /** Process restart: durable rows and receipts survive, the boot id changes. */
  restart(): void { this.service = { ...this.service, bootId: `center-boot-${++this.service.boots}`, startedAt: this.time }; }
  /** New service generation over the same rows: every write still fenced with the old generation is stale_generation. */
  bumpGeneration(): void { this.restart(); this.service.serviceGeneration += 1; }
  backup(): FakeCenterBackup {
    return { state: structuredClone(this.state), serviceGeneration: this.service.serviceGeneration, serverSeq: this.state.serverSeq };
  }
  /** Restore from a backup: anything committed after it (rows, receipts, batches) is gone, and the generation moves past it. */
  restore(b: FakeCenterBackup): void {
    this.state = structuredClone(b.state);
    this.bumpGeneration();
    this.service.restoredFrom = { serviceGeneration: b.serviceGeneration, serverSeq: b.serverSeq, snapshotDigest: v2ObjectDigest(b.serverSeq) };
  }
  inject(fault: FakeFault): void { this.faults.push({ ...fault, left: fault.times ?? 1 }); }

  /** Test setup rows, validated by the X0 DTO parsers; bypasses command semantics on purpose. */
  seed(rows: { features?: unknown[]; tasks?: unknown[]; workflows?: unknown[]; asks?: unknown[]; dags?: { featureId: string; dag: FakeDag }[] }): void {
    for (const f of rows.features ?? []) { const v = parseDTO("feature", f); this.state.features.set(v.id, v); }
    for (const t of rows.tasks ?? []) { const v = parseDTO("task", t); this.state.tasks.set(v.id, v); }
    for (const w of rows.workflows ?? []) { const v = parseDTO("workflow", w); this.state.workflows.set(v.taskId, v); }
    for (const a of rows.asks ?? []) { const v = parseDTO("ask", a); this.state.asks.set(v.id, v); }
    for (const { featureId, dag } of rows.dags ?? []) this.state.dags.set(featureId, parseDTO("dag", dag));
  }
  /** Read-only views for assertions. */
  feature(id: string): V2Feature | undefined { return structuredClone(this.state.features.get(id)); }
  rows(): FakeCenterState { return structuredClone(this.state); }

  handle(req: FakeRequest): FakeResponse {
    const match = matchV2Route(req.method, req.url);
    const entry: FakeLogEntry = { method: req.method, url: req.url, route: match?.name ?? null, command: null, status: 0 };
    this.log.push(entry);
    let requestId: string | null = null;
    try {
      if (!match) return fail("not_found");
      if (!req.actor) return fail("unauthenticated");
      const actor = parseActor(req.actor), route = V2_ROUTES[match.name] as (typeof V2_ROUTES)[V2RouteName];
      const params = route.parseParams(match.params as never) as Record<string, any>;
      if (params.teamId !== this.scope.teamId || params.projectId !== this.scope.projectId) fail("not_found");
      if (!actor.projects.includes(this.scope.projectId) || !this.roles[actor.personId]) fail("not_member");
      const body = route.parseRequest(req.body, params as never) as any;
      if (match.name === "commands") { entry.command = body.type; requestId = body.requestId; }
      const fault = this.takeFault(match.name, entry.command);
      if (fault === "unavailable") fail("unavailable");
      const out = this.dispatch(match.name, params, body, actor);
      let served: unknown;
      try { served = route.parseResponse(structuredClone(out), params as never); }
      catch (e) { throw new Error(`fake center built an invalid ${match.name} body: ${String(e)}`); }
      if (fault === "drop") { entry.status = "dropped"; throw new FakeCenterDropped(); }
      entry.status = 200;
      return { status: 200, body: served };
    } catch (e) {
      if (!(e instanceof V2ContractError)) throw e;
      entry.status = e.status;
      return { status: e.status, body: { code: e.code, message: "", requestId } };
    }
  }

  /** A fetch for real transports: `identify` is the verified-signature step (null = unauthenticated); a drop rejects like the network. */
  fetch(identify: (request: Request) => V2Actor | null): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init), url = new URL(request.url), text = await request.text();
      let body: unknown;
      try { body = text === "" ? undefined : JSON.parse(text); }
      catch { return Response.json({ code: "invalid_field", message: "", requestId: null }, { status: 400 }); /* malformed JSON is a 400, not a fixture error */ }
      try {
        const res = this.handle({ method: request.method, url: url.pathname + url.search, body, actor: identify(request) });
        return Response.json(res.body, { status: res.status });
      } catch (e) {
        if (e instanceof FakeCenterDropped) throw new TypeError("fetch failed");
        throw e;
      }
    };
  }

  private takeFault(route: V2RouteName, command: V2CommandName | null): FakeFault["kind"] | null {
    const i = this.faults.findIndex(f => (!f.route || f.route === route) && (!f.command || f.command === command));
    if (i < 0) return null;
    const f = this.faults[i];
    if (--f.left <= 0) this.faults.splice(i, 1);
    return f.kind;
  }
  /** Runs `fn` on a draft; the draft replaces the state only if fn returns (a failed command writes nothing). */
  private transact<T>(fn: (t: TransferContext) => T): T {
    const draft = structuredClone(this.state);
    const out = fn({ state: draft, scope: this.scope, serviceGeneration: this.service.serviceGeneration, now: this.time });
    this.state = draft;
    return out;
  }
  private owner(actor: V2Actor): void { if (this.roles[actor.personId] !== "owner") fail("forbidden"); }

  private dispatch(name: V2RouteName, p: Record<string, any>, body: any, actor: V2Actor): unknown {
    const s = this.state;
    switch (name) {
      case "commands": return this.submit(body, actor);
      case "receipts": return this.receipt(p, actor);
      case "asks": return must(s.asks.get(p.askId));
      case "features": return featureView(s, this.scope, this.service.serviceGeneration, p.featureId);
      case "lend": {
        const order = must(s.orders.get(p.orderId));
        return { order, lease: s.lendLeases.get(order.orderId) ?? null, task: must(s.tasks.get(order.taskId)), now: this.time };
      }
      case "migrations": this.owner(actor); return this.transact(t => migrate(t, body));
      case "reverts": this.owner(actor); return this.transact(t => revert(t, body));
      case "migration": return lookup(this.transfer(), "migration", p.batchId);
      case "revert": return lookup(this.transfer(), "revert", p.batchId);
    }
  }
  private transfer(): TransferContext {
    return { state: this.state, scope: this.scope, serviceGeneration: this.service.serviceGeneration, now: this.time };
  }
  private receipt(p: Record<string, any>, actor: V2Actor) {
    const r = this.state.receipts.get(receiptKey(actor.personId, actor.instanceId, p.requestId));
    if (r && (r.commandDigest !== p.commandDigest || (p.operationId !== null && r.result.operationId !== p.operationId))) fail("dedup_mismatch");
    return { ...this.scope, requestId: p.requestId, status: r ? "committed" : "unknown", receipt: r ?? null };
  }

  /** Dedup first (a replay of a committed body always returns its receipt), then generation, role, execution, epoch. */
  private submit(command: V2Command, actor: V2Actor): V2Receipt {
    const key = receiptKey(actor.personId, actor.instanceId, command.requestId), commandDigest = v2ObjectDigest(command);
    const prior = this.state.receipts.get(key);
    if (prior) return prior.commandDigest === commandDigest ? prior : fail("dedup_mismatch");
    if (command.serviceGeneration !== this.service.serviceGeneration) fail("stale_generation");
    return this.transact(({ state, now }) => {
      const feature = commandFeature(state, command), policy = V2_COMMAND_POLICY[command.type];
      if (policy.actor === "owner") this.owner(actor);
      const executorSide = ["lend.claim", "lend.renew", "lend.result"].includes(command.type);
      if (policy.actor === "home_or_scoped_service" && !executorSide && (actor.kind === "service"
        ? !actor.actions.includes(command.type) : feature?.homeInstanceId !== actor.instanceId)) fail("wrong_home");
      if (policy.executionOnly && feature?.authorityMode !== "execution") fail("execution_not_shared");
      if (feature && command.epoch !== feature.epoch) fail("stale_epoch");
      const handler = (this.handlers[command.type] as CommandHandler | undefined) ?? fail("conflict");
      const seq = state.serverSeq + 1;
      const result = handler({ state, command, actor, now, feature, seq });
      state.serverSeq = seq;
      const receipt: V2Receipt = { ...this.scope, schemaVersion: 2, serviceGeneration: this.service.serviceGeneration,
        requestId: command.requestId, personId: actor.personId, instanceId: actor.instanceId, commandDigest, command: command.type,
        serverSeq: seq, committedAt: now, result: { entityId: result.entityId, rev: result.rev, specRev: result.specRev ?? null,
          version: result.version ?? null, epoch: command.epoch, operationId: execOperationId(command) } };
      state.receipts.set(key, receipt);
      return receipt;
    });
  }
}

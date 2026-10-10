/**
 * S2F · stage-two composition core shared by the bridge and scheduler processes (plan §2.2「configure 端口」, appendix S2F).
 * Credentials come only from local configuration (`resolveSharedLedgerCredential`); a missing credential, binding or instance
 * key yields null, which every node reads as "center not wired" (unavailable). Clients are cached per Principal + local
 * project and never shared across Principals. The switch is S2S's effective mode, re-read on every call (revocation is seen
 * at the next check). Nothing here performs a center request until a node asks for one, so off = zero requests.
 * Process roots: scheduler-v2-wiring.ts (scheduler) and bridge/shared-ledger-v2-wiring.ts (bridge).
 */
import type { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTask } from "./ledger-store.js";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";
import { instanceKeySync } from "./instance-key.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { readSharedLedgerMode, resolveSharedLedgerCredential, type SharedLedgerMode } from "./shared-ledger-mode.js";
import { readStage2Switch, type Stage2Switch } from "./shared-ledger-v2-switch.js";
import { createStage2Transport, type Stage2Transport } from "./shared-ledger-v2-transport.js";
import { SharedLedgerExecClient } from "./shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "./shared-ledger-exec-gate.js";
import {
  fail, parseAsk, V2_COMMAND_NAMES, type V2Ask, type V2Command, type V2Fence,
} from "./shared-ledger-contract-v2.js";
import { parseFeatureView } from "./shared-ledger-contract-v2-routes.js";

/** The bridge's own (home) Principal, the same subject the other shared-ledger wirings resolve. */
const OWNER_SUBJECT = "owner:self";
export interface Stage2Principal { subject: string; kind: "person" | "service" }
export const OWNER_PRINCIPAL: Stage2Principal = { subject: OWNER_SUBJECT, kind: "person" };
export interface ExecFeatureRef { localFeatureId: string; projectId: string; centerFeatureId: string; epoch: number }
export type Stage2View = ReturnType<typeof parseFeatureView>;
export interface Stage2Opened { scope: SharedLedgerBinding; transport: Stage2Transport; client: SharedLedgerExecClient }
/** The signing identity travels with its transport: the gate's actor must be the one the requests are signed with. */
export interface Stage2Connected { transport: Stage2Transport; personId: string; instanceId: string }
export interface Stage2WiringOptions {
  dir?: string;
  /** Default: local binding + credential (action plan) + instance key → S2T transport. null = not wired. */
  connect?(who: Stage2Principal, scope: SharedLedgerBinding): Stage2Connected | null;
  /** Default connect's fetch (tests count requests through it). */
  fetch?: typeof fetch;
  /** The project role the local registration grants; default owner only for the bridge's own Principal. */
  role?(who: Stage2Principal, scope: SharedLedgerBinding): "owner" | "member";
  /** Current fence for a center feature (scheduler: S2R lease); default = the cached view's generation / epoch. */
  fenceOf?(centerFeatureId: string, command: V2Command): V2Fence | null;
}

const key = (who: Stage2Principal, project: string) => `${who.kind}:${who.subject}\0${project}`;
const OBSERVE_FILE = "shared-ledger-v2-observe.jsonl";
const OBSERVE_MAX_BYTES = 4 * 1024 * 1024;

function defaultConnect(dir: string, fetchImpl?: typeof fetch) {
  return (who: Stage2Principal, scope: SharedLedgerBinding): Stage2Connected | null => {
    const credential = resolveSharedLedgerCredential(who.subject, who.kind, scope.centerId, scope.teamId, scope.projectId, "plan", dir);
    const instanceKey = credential ? instanceKeySync(dir) : null;
    if (!credential || !instanceKey) return null;
    return { transport: createStage2Transport({ connection: credential, key: instanceKey, projectId: scope.projectId,
      ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
      personId: credential.personId, instanceId: credential.instanceId };
  };
}

export class Stage2Wiring {
  readonly dir: string;
  private readonly clients = new Map<string, Stage2Opened | null>();
  private readonly views = new Map<string, Stage2View>();
  private readonly asks = new Map<string, V2Ask>();
  private readonly connect: NonNullable<Stage2WiringOptions["connect"]>;

  constructor(private readonly options: Stage2WiringOptions = {}) {
    this.dir = options.dir ?? STATE_DIR;
    this.connect = options.connect ?? defaultConnect(this.dir, options.fetch);
  }

  /** S2S effective switch; unreadable state reads as off (no center request), never as on. */
  mode(project: string): Stage2Switch {
    try { return readStage2Switch(project, this.dir); }
    catch (e) {
      console.warn(`[stage2-wiring] switch unreadable for ${project}: ${(e as Error).message}`);
      return "off";
    }
  }

  /** The center project a local project is bound to (shared-ledger-bindings.json); none or ambiguous = null. */
  scope(project: string): SharedLedgerBinding | null {
    try {
      const found = readSharedLedgerBindings(this.dir).filter((b) => b.localProjectId === project);
      return found.length === 1 ? found[0]! : null;
    } catch { return null; }
  }

  /** One cached client per Principal + project; a failed resolution is not cached so a later credential is picked up. */
  open(who: Stage2Principal, project: string): Stage2Opened | null {
    const k = key(who, project), hit = this.clients.get(k);
    if (hit) return hit;
    const scope = this.scope(project);
    if (!scope) return null;
    let connected: Stage2Connected | null;
    try { connected = this.connect(who, scope); }
    catch (e) {
      console.warn(`[stage2-wiring] credential for ${project} unusable: ${(e as Error).message}`);
      return null;
    }
    if (!connected) return null;
    const opened: Stage2Opened = { scope, transport: connected.transport, client: this.client(who, scope, connected) };
    this.clients.set(k, opened);
    return opened;
  }
  clientFor(who: Stage2Principal, project: string): SharedLedgerExecClient | null { return this.open(who, project)?.client ?? null; }
  transportFor(project: string, who: Stage2Principal = OWNER_PRINCIPAL): Stage2Transport | null { return this.open(who, project)?.transport ?? null; }
  /** Drop cached clients (credential rotation / tests). */
  reset(): void { this.clients.clear(); this.views.clear(); this.asks.clear(); }

  private client(who: Stage2Principal, scope: SharedLedgerBinding, connected: Stage2Connected): SharedLedgerExecClient {
    const { transport } = connected, actor = { personId: connected.personId, instanceId: connected.instanceId };
    const identity = (): ExecIdentity => {
      return { centerId: scope.centerId, teamId: scope.teamId, projectId: scope.projectId,
        actor: { kind: "person", personId: actor.personId, instanceId: actor.instanceId, serviceId: null, representedPersonId: null,
          orderId: null, projects: [scope.projectId], actions: [...V2_COMMAND_NAMES] },
        projectRole: this.options.role?.(who, scope) ?? (who.subject === OWNER_SUBJECT ? "owner" : "member"),
        registeredPersonId: actor.personId, registeredInstanceId: actor.instanceId };
    };
    const gate = new SharedLedgerExecGate({ modeDirectory: this.dir, identity, context: (command) => {
      const view = this.viewOf(command);
      if (!view) return fail("unavailable");
      const fence = this.options.fenceOf ? this.options.fenceOf(view.feature.id, command)
        : { serviceGeneration: view.serviceGeneration, epoch: view.feature.epoch, bootId: command.bootId };
      if (!fence) return fail("unavailable");
      return { feature: view.feature, fence, orderId: null };
    } });
    const wiring = this;
    /** The gate is synchronous; the first command for a feature primes its view from the center. */
    return new (class extends SharedLedgerExecClient {
      override async command(input: V2Command) {
        if (!wiring.viewOf(input)) {
          const featureId = wiring.centerFeatureOf(input);
          if (featureId) await wiring.snapshotCenter(transport, featureId);
        }
        return super.command(input);
      }
    })(gate, transport.exec);
  }

  private centerFeatureOf(command: V2Command): string | null {
    const p = command.payload as Record<string, unknown>;
    if (typeof p.featureId === "string") return p.featureId;
    const taskId = typeof p.taskId === "string" ? p.taskId : null;
    for (const view of this.views.values()) if (taskId && view.tasks.some((t) => t.id === taskId)) return view.feature.id;
    return null;
  }
  private viewOf(command: V2Command): Stage2View | null {
    const featureId = this.centerFeatureOf(command);
    const view = featureId ? this.views.get(featureId) : undefined;
    return view && view.teamId === command.teamId && view.projectId === command.projectId ? view : null;
  }

  private async snapshotCenter(transport: Stage2Transport, centerFeatureId: string): Promise<Stage2View> {
    const view = parseFeatureView(await transport.snapshot(centerFeatureId));
    this.views.set(centerFeatureId, view);
    for (const ask of view.pendingAsks) this.asks.set(ask.id, ask);
    return view;
  }
  /** Center snapshot for a local feature (S2P sync / S2E). Caches the view for gate context and X8 contexts. */
  async snapshot(project: string, featureId: string, who: Stage2Principal = OWNER_PRINCIPAL): Promise<Stage2View> {
    const ref = this.featureRef(featureId, project);
    const transport = this.transportFor(project, who);
    if (!ref || !transport) return fail("unavailable");
    return this.snapshotCenter(transport, ref.centerFeatureId);
  }
  cachedView(centerFeatureId: string): Stage2View | null { return this.views.get(centerFeatureId) ?? null; }
  /** Authorization asks are read online (S2T asks) and kept only as binding evidence for X8 contexts, never as a grant. */
  async fetchAsk(project: string, askId: string): Promise<V2Ask | null> {
    const transport = this.transportFor(project);
    if (!transport) return null;
    const ask = parseAsk(await transport.ask(askId));
    this.asks.set(ask.id, ask);
    return ask;
  }
  cachedAsk(askId: string): V2Ask | null { return this.asks.get(askId) ?? null; }
  /** An injected connector, or a local credential file with entries. */
  wired(): boolean { return this.options.connect !== undefined || this.hasCredentials(); }
  /** Any local credential at all: without one every configure port is injected as null (plan S2F「缺失注入 null」). */
  hasCredentials(): boolean {
    const state = readJsonStateSync(join(this.dir, "shared-ledger-credentials.json"));
    return state.status === "ok" && Array.isArray((state.data as { credentials?: unknown[] }).credentials)
      && (state.data as { credentials: unknown[] }).credentials.length > 0;
  }

  readMode(featureId: string): (SharedLedgerMode & { migrating?: unknown }) | null {
    try { return readSharedLedgerMode(featureId, this.dir); } catch { return null; }
  }
  /** execution features only: the center binding recorded by X13 in the mode file. */
  featureRef(featureId: string, project: string): ExecFeatureRef | null {
    const c = this.readMode(featureId)?.centerExecution;
    return c ? { localFeatureId: featureId, projectId: project, centerFeatureId: c.centerFeatureId, epoch: c.epoch } : null;
  }
  featureOfTask(db: Database | null, taskId: string): ExecFeatureRef | null {
    const task = db ? getTask(db, taskId) : null;
    const featureId = task?.featureId ?? task?.extra.sharedFeatureId;
    return task && typeof featureId === "string" ? this.featureRef(featureId, task.project) : null;
  }

  /** observe log: one JSON line per decision, 0600, capped (oldest half is not rotated, the file simply stops growing). */
  observe(entry: Record<string, unknown>): void {
    const path = join(this.dir, OBSERVE_FILE);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (existsSync(path) && Bun.file(path).size > OBSERVE_MAX_BYTES) return;
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (e) { console.warn(`[stage2-wiring] observe log failed: ${(e as Error).message}`); }
  }
}

export function readStage2ObserveLog(dir = STATE_DIR, project?: string, limit = 50): Record<string, unknown>[] {
  const path = join(dir, OBSERVE_FILE);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  return rows.filter((r) => !project || r.project === project).slice(-limit);
}

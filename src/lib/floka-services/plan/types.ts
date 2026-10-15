/** Injected ports only: this package never opens files, runs commands or installs services. */
export type Side = "old" | "new";
export interface Service { name: string; oldLabel: string; newLabel: string; plist: string }
export interface ServicePlan { id: string; services: readonly Service[]; legacyLabels: readonly string[] }
export interface State {
  /** null means unknown, never absence. loaded includes KeepAlive even between process launches. */
  loaded: boolean | null;
  /** All surviving processes, including descendants/orphans of an unloaded job; null means unknown. */
  pids: readonly number[] | null;
  /** Job main processes only. Older adapters may omit this when pids already counts main processes. */
  instances?: readonly number[] | null;
}
interface LegacyState extends State { restartDisabled: boolean }
export interface Lease { assertHeld(): void }
export interface Journal {
  version: 1;
  planKey: string;
  direction: "forward" | "rollback";
  /** Next operation; saved before any effects, advanced only after successful verification. */
  cursor: number;
  status: "running" | "committed" | "rolled-back";
  /** Immutable recovery input; callers may have upgraded Bun or moved the checkout since preparation. */
  snapshot?: ServicePlan;
}

/**
 * Host adapter contract: mutations are durable and idempotent by plan.id/service, including uncertain replies.
 * prepare retains the original configuration once and stages new plists outside auto-load paths; no load.
 * unload retains configurations even without prepare, disables restart sources, and unregisters the job.
 * restoreOld restores that immutable backup (no-op if never prepared), without loading anything.
 * commit records the chosen side but retains backups until a separate, explicitly approved cleanup.
 */
export interface Controller {
  /** One machine/service-set lock and journal, shared across transaction IDs and installer/restart actors.
   * Do not expire/take over while a port call is in flight; each mutation must enforce the held lease.
   * Real adapters should reuse lib/file-lock.ts, never implement an independent installer lock here.
   */
  withLock<T>(key: string, run: (lease: Lease) => Promise<T>): Promise<T>;
  readJournal(): Promise<Journal | null>;
  /** Atomic durable replace; rejection may mean the write landed. Resume must reread, never guess. */
  saveJournal(journal: Journal): Promise<void>;
  auditLegacy(plan: ServicePlan): Promise<Record<string, LegacyState>>;
  inspect(plan: ServicePlan, service: Service, side: Side): Promise<State>;
  prepare(plan: ServicePlan, service: Service): Promise<void>;
  unload(plan: ServicePlan, service: Service, side: Side): Promise<void>;
  /** Bounded wait including tracked child/orphan PIDs; false/throw never authorizes the opposite load. */
  waitExited(plan: ServicePlan, service: Service, side: Side): Promise<boolean>;
  restoreOld(plan: ServicePlan, service: Service): Promise<void>;
  load(plan: ServicePlan, service: Service, side: Side): Promise<void>;
  health(plan: ServicePlan, service: Service, side: Side): Promise<boolean>;
  commit(plan: ServicePlan, side: Side): Promise<void>;
}
export interface Options {
  plan: ServicePlan;
  controller: Controller;
  rename?: { services?: unknown };
  action?: "resume" | "rollback";
}
export interface Result {
  status: "off" | "observed" | "blocked" | "committed" | "rolled-back";
  plan: ServicePlan;
  /** Diagnostic only; after uncertain I/O the durable journal is authoritative on next invocation. */
  journal?: Journal;
  error?: string;
}

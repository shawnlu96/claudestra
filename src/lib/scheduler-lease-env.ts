/**
 * The scheduler service's lease, carried into the manager / ledger subprocesses it spawns. The parent only knows it is
 * still the owner before the spawn and after the exit; the child may wait for the manager write lock, read registry and
 * projects, and only then write. So the child takes the lease identity (lock path + token of scheduler.pid and of the
 * maintenance lease) and re-checks it itself, synchronously, right before each effect (`assertSchedulerLease`): file writes,
 * every tmux spawn (lib/tmux-helper.ts), every program-input record and every bridge frame (lib/bridge-client.ts).
 * A child started as the service (CLAUDESTRA_SCHEDULER_SERVICE=1) without a readable lease fails closed. Ordinary CLI runs
 * carry no lease and are unchanged. Tests: tests/scheduler-lease-env.test.ts, tests/scheduler-child-lease.test.ts.
 */
import { lockOwnedBy } from "./file-lock.js";
import { writeJsonAtomic, writeJsonAtomicSync } from "./state-file.js";

export const SCHEDULER_LEASE_ENV = "CLAUDESTRA_SCHEDULER_LEASE";

export interface LeaseHold { path: string; token: string }
/** Both leases, named: a payload missing either (or naming one lock twice) is not a lease and fails closed. */
export interface SchedulerLease { singleton: LeaseHold; maintenance: LeaseHold }

export class SchedulerLeaseLost extends Error {}

/** No lease → an empty value, which a child reads as "must be leased, is not" and refuses every effect. */
export const encodeLease = (lease: SchedulerLease | undefined): string => (lease ? JSON.stringify({ v: 1, ...lease }) : "");

const holdOk = (h: unknown): h is LeaseHold => {
  const x = h as Partial<LeaseHold> | null;
  return !!x && typeof x.path === "string" && !!x.path && typeof x.token === "string" && !!x.token;
};

function decode(raw: string): LeaseHold[] | null {
  try {
    const v = JSON.parse(raw) as { v?: unknown; singleton?: unknown; maintenance?: unknown } | null;
    if (!v || v.v !== 1 || !holdOk(v.singleton) || !holdOk(v.maintenance) || v.singleton.path === v.maintenance.path) return null;
    return [v.singleton, v.maintenance];
  } catch { return null; /* 坏 env 当没租约：调度身份下随后 fail closed */ }
}

/** null = not a leased run; [] = must be leased but the lease is missing or unreadable (every check fails). */
let adopted: LeaseHold[] | null = null;

/**
 * Read the lease once at process start and drop it from the environment, so a session or tool this process spawns
 * (manager create starts an agent) never inherits a lease that will long be gone.
 */
export function adoptSchedulerLease(env: Record<string, string | undefined> = process.env): void {
  const raw = env[SCHEDULER_LEASE_ENV];
  delete env[SCHEDULER_LEASE_ENV];
  if (raw !== undefined) adopted = decode(raw) ?? [];
  else if (env.CLAUDESTRA_SCHEDULER_SERVICE === "1") adopted = [];
}

export const leasedRun = (): boolean => adopted !== null;

/** Explicit lifecycle children only; never restore the lease into process.env or an agent's inherited environment. */
export function forwardSchedulerLease(): string | undefined {
  return adopted === null ? undefined : adopted.length === 0 ? "" : encodeLease({ singleton: adopted[0], maintenance: adopted[1] });
}

/** Synchronous: call it with no await between it and the write it guards. */
export function assertSchedulerLease(): void {
  if (adopted === null) return;
  if (adopted.length === 0) throw new SchedulerLeaseLost("调度服务子进程没带可读的租约，拒绝写入");
  const lost = adopted.find((h) => !lockOwnedBy(h.path, h.token));
  if (lost) throw new SchedulerLeaseLost(`调度服务已失租或已停止（${lost.path}），本次不写`);
}

/** For an entry point: the lease-lost message, or null when this run may go on. */
export function schedulerLeaseRefusal(): string | null {
  try { assertSchedulerLease(); return null; } catch (e) { return (e as Error).message; }
}

/** Atomic JSON write; in a leased run the lease is re-checked between the tmp write and the rename, with no await between. */
export async function writeJsonLeased(path: string, data: unknown, commitCheck?: () => void): Promise<void> {
  if (adopted === null && !commitCheck) return writeJsonAtomic(path, data);
  writeJsonAtomicSync(path, data, { commitIf: () => { commitCheck?.(); assertSchedulerLease(); return true; } });
}

/** Tests only: forget the adopted lease. */
export function resetSchedulerLeaseForTest(): void { adopted = null; }

import { api } from "./api/client";
import { machines } from "./machines";

/** Target capability and hosting bridge recovery policy have independent lifetimes. */
export type SteerQueueMode = "on" | "observe" | "off";
export type QueueCapability = "enabled" | "disabled" | "missing" | "invalid" | "failed";

export function steerQueueMode(raw: unknown): SteerQueueMode {
  return raw === "off" || raw === "observe" ? raw : "on";
}

export function queueCapability(raw: unknown, failed = false): QueueCapability {
  if (failed) return "failed";
  if (raw === true) return "enabled";
  if (raw === false) return "disabled";
  return raw === undefined ? "missing" : "invalid";
}

/** Observe/off preserve the old !== false parser; transport failure still fails the old action. */
export function queueWhenBusy(raw: unknown, mode: SteerQueueMode, failed = false): boolean {
  return mode === "on" ? !failed && raw === true : raw !== false;
}

export interface QueueRead { fp: string | null; epoch: number; ticket: number }
export class SteerQueueStaleRead extends Error {
  constructor() { super("settings target changed"); }
}

/** Reads from another selection or superseded by a newer read/write cannot publish a cached capability. */
export class SteerQueueCache {
  private epoch = 0;
  private tickets = new Map<string | null, number>();
  private values = new Map<string | null, unknown>();

  switchMachine(): void { this.epoch++; }
  selection(fp: string | null): Pick<QueueRead, "fp" | "epoch"> { return { fp, epoch: this.epoch }; }
  begin(fp: string | null): QueueRead {
    const ticket = (this.tickets.get(fp) ?? 0) + 1;
    this.tickets.set(fp, ticket);
    return { fp, epoch: this.epoch, ticket };
  }
  current(read: QueueRead, fp: string | null): boolean {
    return this.selected(read, fp) && read.ticket === this.tickets.get(fp);
  }
  selected(read: Pick<QueueRead, "fp" | "epoch">, fp: string | null): boolean { return read.fp === fp && read.epoch === this.epoch; }
  finish(read: QueueRead, fp: string | null, raw: unknown): boolean {
    if (!this.current(read, fp)) return false;
    this.values.set(fp, raw);
    return true;
  }
  enabled(fp: string | null, mode: SteerQueueMode): boolean {
    return queueWhenBusy(this.values.get(fp), mode);
  }
  capability(fp: string | null, failed = false): QueueCapability { return queueCapability(this.values.get(fp), failed); }
}

interface QueueSettings { raw: Record<string, unknown>; mode: SteerQueueMode; read: QueueRead }
const capabilities = new SteerQueueCache();
const pendingSettings = new Map<string | null, Promise<QueueSettings>>();
const pendingWrites = new Map<string | null, Set<Promise<QueueSettings>>>();
machines.onSwitch(() => { capabilities.switchMachine(); pendingSettings.clear(); });
let controlRead = 0;
let controlPending: Promise<SteerQueueMode> | null = null;

/** This URL deliberately stays on the page's origin, even when the selected machine lives behind /m/<fp>. */
export function getSteerQueueRecovery(): Promise<SteerQueueMode> {
  const ticket = ++controlRead;
  const result = (async () => {
    let mode: SteerQueueMode = "on";
    try {
      const res = await fetch("/api/v1/settings/steer-queue-recovery", {
        credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (res.ok) mode = steerQueueMode((await res.json() as { mode?: unknown } | null)?.mode);
    } catch {
      // An absent/unreachable hosting projection cannot establish an opt-out of the conservative capability check.
    }
    return ticket === controlRead || !controlPending ? mode : controlPending;
  })();
  controlPending = result;
  return result;
}

const observed = new Set<string>();
const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);

async function observeCapability(fp: string | null, capability: QueueCapability): Promise<void> {
  try {
    const version = await api<{ version?: unknown; commit?: unknown }>("/version", { timeoutMs: 8000 }, fp ? { fp } : undefined)
      .catch(() => ({ version: "unknown", commit: "" })); // Old bridges without /version still produce one opaque unknown-version sample.
    const [target, rev] = await Promise.all([digest(fp ?? "local"), digest(JSON.stringify([version.version, version.commit]))]);
    const key = `${target}:${rev}`;
    if (observed.has(key)) return;
    const res = await fetch("/api/v1/settings/steer-queue-observation", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "x-cstra-device": "1" },
      body: JSON.stringify({ target, version: rev, capability }), signal: AbortSignal.timeout(8000),
    });
    if (res.ok && (await res.json() as { recorded?: unknown }).recorded === true) observed.add(key);
  } catch {
    // Sampling is best effort and never delays or changes the baseline send in observe mode.
  }
}

async function readSettings(patch?: unknown): Promise<QueueSettings> {
  const fp = machines.currentFp(), read = capabilities.begin(fp);
  const [raw, mode] = await Promise.all([api<Record<string, unknown>>("/settings", {
    ...(patch ? { method: "PUT", json: patch } : {}), timeoutMs: 8000,
  }, fp ? { fp } : undefined), getSteerQueueRecovery()]);
  if (!capabilities.selected(read, machines.currentFp())) throw new SteerQueueStaleRead();
  // Supersession only prevents publishing capability; successful unrelated settings reads/writes still reach their callers.
  capabilities.finish(read, machines.currentFp(), raw["steer.queueWhenBusy"]);
  return { raw, mode, read };
}
export function readSteerQueueSettings(patch?: unknown): Promise<QueueSettings> {
  if (patch) {
    const fp = machines.currentFp();
    pendingSettings.delete(fp);
    let writes = pendingWrites.get(fp);
    if (!writes) pendingWrites.set(fp, writes = new Set());
    const result = readSettings(patch).finally(() => {
      writes.delete(result);
      if (!writes.size && pendingWrites.get(fp) === writes) pendingWrites.delete(fp);
      // A GET launched during the write may have captured the pre-write value; the next send must probe after it settled.
      pendingSettings.delete(fp);
    });
    writes.add(result);
    return result;
  }
  const fp = machines.currentFp();
  const pending = pendingSettings.get(fp);
  if (pending) return pending;
  const result = readSettings().finally(() => {
    if (pendingSettings.get(fp) === result) pendingSettings.delete(fp);
  });
  pendingSettings.set(fp, result);
  return result;
}
/** A failed probe never establishes queue support; an idle target may still accept a normal message. */
export async function getSteerQueueForSend(): Promise<boolean> {
  const fp = machines.currentFp(), selection = capabilities.selection(fp);
  try {
    for (;;) {
      // Let mutations settle before probing; a focus GET must not let a send overtake a pending opt-out PUT.
      await Promise.allSettled([...(pendingWrites.get(fp) ?? [])]);
      if (!capabilities.selected(selection, machines.currentFp())) throw new SteerQueueStaleRead();
      const { read } = await readSteerQueueSettings();
      const mode = await getSteerQueueRecovery();
      if (!capabilities.selected(selection, machines.currentFp())) throw new SteerQueueStaleRead();
      if (pendingWrites.get(fp)?.size || !capabilities.current(read, fp)) continue;
      if (mode === "observe") void observeCapability(fp, capabilities.capability(fp));
      return capabilities.enabled(fp, mode);
    }
  }
  catch (e) {
    const mode = await getSteerQueueRecovery();
    if (!capabilities.selected(selection, machines.currentFp())) throw new SteerQueueStaleRead();
    if (mode === "observe") void observeCapability(fp, "failed");
    if (mode !== "on") throw e;
    return false;
  }
}

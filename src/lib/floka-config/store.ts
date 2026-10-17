import { isDeepStrictEqual } from "node:util";
import { readJsonState, writeJsonStateGuarded } from "../state-file.js";
import { autoUpdateValue, configConflicts, object } from "./values.js";
import { ConfigChangedError } from "./retry.js";
import type { AppConfig } from "../config-store.js";
import { barrierActive } from "../state-maintenance/barrier.js";
import { configWriteMode, holdsConfigWriteLock, observeConfigWrite, withConfigWriteLock } from "./write-lock.js";

// Keep the source document separate from the sanitized public view. A setter must not erase
// unknown fields or rewrite unrelated values merely because the old schema did not expose them.
// exists=false is the snapshot of a missing file (CFGWRITE1): creating it after the read is a version change too.
const sources = new WeakMap<object, { exists: boolean; raw: Record<string, any>; view: Record<string, any> }>();

export function configView(raw: unknown, view: AppConfig, exists = true): AppConfig {
  const source = object(raw);
  const conflicts = configConflicts(raw);
  if (conflicts.length) {
    Object.defineProperty(view, "configConflicts", { value: conflicts, enumerable: false });
    console.error(`[floka-config] ${conflicts.map(c => c.message).join("; ")}; reading legacy value when valid`);
  }
  if (object(source.autoUpdate).floka !== undefined) {
    Object.defineProperty(view.autoUpdate, "floka", {
      enumerable: true, configurable: true,
      get: () => view.autoUpdate.claudestra,
      set: (value: boolean) => { view.autoUpdate.claudestra = value; },
    });
  }
  sources.set(view.autoUpdate, { exists, raw: structuredClone(source), view: structuredClone(view) });
  return view;
}

/** Apply only edits to the public view, preserving fields that it did not expose. */
function edited(raw: Record<string, any>, before: Record<string, any>, after: Record<string, any>): Record<string, any> {
  const out = structuredClone(raw);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    if (!(key in after) || after[key] === undefined) delete out[key];
    else if (after[key] && typeof after[key] === "object" && !Array.isArray(after[key])) {
      out[key] = edited(object(raw[key]), object(before[key]), after[key]);
    } else out[key] = after[key];
  }
  return out;
}

/** Under the config write lock (write-lock.ts, mode on) the reread, snapshot check, merge and atomic write are one step. */
export function writeCompatibleConfig(path: string, cfg: AppConfig): Promise<void> {
  return withConfigWriteLock(path, () => writeLocked(path, cfg));
}

async function writeLocked(path: string, cfg: AppConfig): Promise<void> {
  if (barrierActive()) throw new Error("state root maintenance in progress; refusing configuration write");
  const disk = await readJsonState(path);
  const raw = disk.status === "ok" ? object(disk.data) : {};
  autoUpdateValue(raw.autoUpdate, true); // Recheck disk too, even if the caller supplied a replacement object.
  const value = autoUpdateValue(cfg.autoUpdate, true);
  const source = sources.get(cfg.autoUpdate);
  if (source?.exists && disk.status === "ok" && !isDeepStrictEqual(source.raw, raw)) {
    throw new ConfigChangedError();
  }
  // Serialized writes also treat a file created or deleted since the read as a new version; corrupt still fails below.
  const moved = source && (source.exists ? disk.status === "missing" : disk.status === "ok");
  const serialized = holdsConfigWriteLock(path);
  if (moved && serialized) throw new ConfigChangedError();
  if (moved && configWriteMode() === "observe") await observeConfigWrite(path, source.exists ? "deleted" : "missing-changed", raw);
  const out = edited(raw, (serialized || source?.exists ? source?.view : undefined) ?? {}, cfg);
  const previous = object(raw.autoUpdate);
  const au = object(out.autoUpdate);
  // Routine setters retain spelling. Adding the new brand key requires the explicit config transaction.
  if (previous.claudestra === undefined && previous.floka !== undefined) delete au.claudestra;
  if (previous.floka !== undefined) au.floka = value;
  if (previous.claudestra !== undefined) au.claudestra = value;
  if (Object.keys(au).length) out.autoUpdate = au;
  await writeJsonStateGuarded(path, out, { mode: 0o600 });
}

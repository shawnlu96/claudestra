import { isDeepStrictEqual } from "node:util";
import { readJsonState, writeJsonStateGuarded } from "../state-file.js";
import { autoUpdateValue, object } from "./values.js";
import type { AppConfig } from "../config-store.js";
import { barrierActive } from "../state-maintenance/barrier.js";

// Keep the source document separate from the sanitized public view. A setter must not erase
// unknown fields or rewrite unrelated values merely because the old schema did not expose them.
const sources = new WeakMap<object, { raw: Record<string, any>; view: Record<string, any> }>();

export function configView(raw: unknown, view: AppConfig): AppConfig {
  const source = object(raw);
  if (object(source.autoUpdate).floka !== undefined) {
    Object.defineProperty(view.autoUpdate, "floka", {
      enumerable: true, configurable: true,
      get: () => view.autoUpdate.claudestra,
      set: (value: boolean) => { view.autoUpdate.claudestra = value; },
    });
  }
  sources.set(view.autoUpdate, { raw: structuredClone(source), view: structuredClone(view) });
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

export async function writeCompatibleConfig(path: string, cfg: AppConfig): Promise<void> {
  if (barrierActive()) throw new Error("state root maintenance in progress; refusing configuration write");
  const disk = await readJsonState(path);
  const raw = disk.status === "ok" ? object(disk.data) : {};
  autoUpdateValue(raw.autoUpdate, true); // Recheck disk too, even if the caller supplied a replacement object.
  const value = autoUpdateValue(cfg.autoUpdate, true);
  const source = sources.get(cfg.autoUpdate);
  if (source && disk.status === "ok" && !isDeepStrictEqual(source.raw, raw)) {
    throw new Error("config changed since read; refusing stale automatic overwrite");
  }
  const out = edited(raw, source?.view ?? {}, cfg);
  const previous = object(raw.autoUpdate);
  const au = object(out.autoUpdate);
  // Routine setters retain spelling. Adding the new brand key requires the explicit config transaction.
  if (previous.claudestra === undefined && previous.floka !== undefined) delete au.claudestra;
  if (previous.floka !== undefined) au.floka = value;
  if (previous.claudestra !== undefined) au.claudestra = value;
  if (Object.keys(au).length) out.autoUpdate = au;
  await writeJsonStateGuarded(path, out, { mode: 0o600 });
}

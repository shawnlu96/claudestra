/** Brand compatibility is read-only unless an explicitly enabled migration writes it. */
export type RenameMode = "off" | "observe" | "on";
export const renameMode = (raw: unknown): RenameMode => raw === "on" || raw === "observe" ? raw : "off";
export const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v : {};

/** Report the key names only: configuration can contain credentials. */
export function autoUpdateValue(raw: unknown, fallback: boolean): boolean {
  const au = object(raw);
  const old = au.claudestra, next = au.floka;
  if (old !== undefined && typeof old !== "boolean" || next !== undefined && typeof next !== "boolean") {
    throw new Error("autoUpdate.claudestra / autoUpdate.floka must be booleans; refusing automatic overwrite");
  }
  if (old !== undefined && next !== undefined && old !== next) {
    throw new Error("autoUpdate.claudestra conflicts with autoUpdate.floka; refusing automatic overwrite");
  }
  return next ?? old ?? fallback;
}

export interface ConfigConflict { keys: readonly string[]; message: string }

/** Key names only: neither reports nor logs may contain credential values. */
export function configConflicts(raw: unknown): ConfigConflict[] {
  try { autoUpdateValue(object(raw).autoUpdate, true); return []; } catch (e) {
    return [{ keys: ["autoUpdate.claudestra", "autoUpdate.floka"], message: (e as Error).message }];
  }
}

/** Readers keep legacy precedence; configView exposes and logs the accompanying diagnostic. */
export function readAutoUpdateValue(raw: unknown, fallback: boolean): boolean {
  const au = object(raw);
  return typeof au.claudestra === "boolean" ? au.claudestra : typeof au.floka === "boolean" ? au.floka : fallback;
}

/** The public skills API keeps its legacy vocabulary until its consumers migrate together. */
export function legacyManager(value: "claudestra" | "floka" | "cc-switch" | null): "claudestra" | "cc-switch" | null {
  return value === "floka" ? "claudestra" : value;
}

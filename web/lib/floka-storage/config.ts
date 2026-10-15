/** Browser-local rollout setting; server rollout is deliberately a separate integration. */
export type StorageMode = "off" | "observe" | "on";
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface StoragePort extends KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
}
const MODE_KEY = "rename.webStorage";

export function browserStorage(): StoragePort | null {
  try {
    return (globalThis as unknown as { localStorage?: StoragePort }).localStorage ?? null;
  } catch {
    // Denied site storage must not prevent pairing or make migration opt-in.
    return null;
  }
}

export function readStorageMode(storage: KeyValueStorage | null = browserStorage()): StorageMode {
  try {
    const value = storage?.getItem(MODE_KEY);
    return value === "on" || value === "observe" ? value : "off";
  } catch {
    // A missing/unreadable setting is the default, never permission to migrate.
    return "off";
  }
}

/** Explicit operator action, not a migration write. Applies only to this origin/browser. */
export function setStorageMode(mode: StorageMode, storage: KeyValueStorage | null = browserStorage()): void {
  if (!["off", "observe", "on"].includes(mode)) throw new Error("invalid rename.webStorage mode");
  if (!storage) throw new Error("browser storage unavailable");
  storage.setItem(MODE_KEY, mode);
}

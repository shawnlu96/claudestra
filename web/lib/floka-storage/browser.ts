import { browserStorage, readStorageMode } from "./config";
import { createStorageBackend } from "./database";
import { indexedDbPort, type IdbFactory } from "./idb";
import { migrateLocalStorage } from "./local";
import { reportMigration } from "./report";
import { budgetMode, reportOnce, SYNC_TTL_MS } from "./sync-budget";

const CHANNEL = "floka-storage";
// webStorageBudget=on: the full LS scan runs when another tab changed a legacy key, or past the TTL (old pages are silent).
let localDirty = true;
let localAt = Number.NEGATIVE_INFINITY;

function syncLocalStorage() {
  const storage = browserStorage();
  const mode = readStorageMode(storage);
  if (!storage || mode === "off") return mode;
  const budget = budgetMode();
  if (budget !== "on") reportMigration(migrateLocalStorage({ mode, storage, budget }));
  else if (localDirty || Date.now() - localAt > SYNC_TTL_MS) {
    localDirty = false;
    const report = migrateLocalStorage({ mode, storage, budget });
    localAt = Date.now();
    if (report.status === "interrupted") localDirty = true;
    reportOnce(report.area, JSON.stringify(report), () => reportMigration(report));
  }
  return mode;
}

type Target = { addEventListener?: (type: string, listener: (event: { key?: string | null }) => void) => void };
type Channel = { postMessage(data: unknown): void; onmessage: (() => void) | null };

/** Cross-tab hints only mark work dirty; the next access syncs, so a hint never triggers a write by itself (no echo loop). */
function watchOtherTabs(markDirty: () => void): (() => void) | undefined {
  const scope = globalThis as unknown as Target & { BroadcastChannel?: new (name: string) => Channel };
  try {
    scope.addEventListener?.("storage", (event) => {
      if (event.key === null || event.key?.startsWith("cstra_")) { localDirty = true; markDirty(); } // null = clear()
    });
  } catch { /* no storage events: the TTL still applies */ }
  try {
    if (!scope.BroadcastChannel) return undefined;
    const channel = new scope.BroadcastChannel(CHANNEL);
    channel.onmessage = markDirty;
    return () => channel.postMessage("dirty");
  } catch {
    return undefined;
  }
}

export function browserBackend() {
  // LS migration does not depend on IndexedDB being enabled in this browser.
  syncLocalStorage();
  let factory: IdbFactory | undefined;
  try {
    factory = (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;
  } catch {
    // Site policy may deny the IndexedDB property itself; the caller uses its memory backend.
    return null;
  }
  if (!factory) return null;
  const tabs: { announce?: () => void } = {};
  const backend = createStorageBackend({ port: indexedDbPort(factory), mode: syncLocalStorage, onMutate: () => tabs.announce?.() });
  tabs.announce = watchOtherTabs(backend.markDirty);
  return backend;
}

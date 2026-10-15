import { browserStorage, readStorageMode } from "./config";
import { createStorageBackend } from "./database";
import { indexedDbPort, type IdbFactory } from "./idb";
import { migrateLocalStorage } from "./local";
import { reportMigration } from "./report";

function syncLocalStorage() {
  const storage = browserStorage();
  const mode = readStorageMode(storage);
  if (storage && mode !== "off") reportMigration(migrateLocalStorage({ mode, storage }));
  return mode;
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
  return factory ? createStorageBackend({ port: indexedDbPort(factory), mode: syncLocalStorage }) : null;
}

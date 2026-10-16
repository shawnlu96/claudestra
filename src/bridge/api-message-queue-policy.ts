import { readConfigSync, type AppConfig } from "../lib/config-store.js";
import { steerQueueWhenBusy } from "../lib/steer-queue-policy.js";

/** Validate before uploads or delivery; multipart booleans have an explicit string contract. */
export function parseWaitForIdle(value: unknown, multipart: boolean): boolean {
  if (value === undefined) return false;
  if (multipart && (value === "true" || value === "false")) return value === "true";
  if (!multipart && typeof value === "boolean") return value;
  throw new TypeError("waitForIdle must be a boolean (multipart: true/false)");
}

/** Only ordinary messages ingress consults the rollback flag; held envelopes keep their original promise. */
export function messageWaitForIdle(requested: boolean, cfg: AppConfig = readConfigSync()): boolean {
  return requested && steerQueueWhenBusy(cfg);
}

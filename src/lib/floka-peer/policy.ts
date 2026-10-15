/** Production policy boundary. Reading configuration never changes identity or peer state. */
import { readConfigSync } from "../config-store.js";
import { parseRenameSignatureMode } from "../floka-compat/signature/families.js";
import { parseE2eRename } from "../floka-compat/e2e/families.js";

export type Mode = "off" | "observe" | "on";
export function peerPolicy(config: unknown = readConfigSync()) {
  const rename = (config as { rename?: Record<string, unknown> } | null)?.rename;
  const mode = (v: unknown): Mode => v === "on" || v === "observe" ? v : "off";
  return {
    signature: parseRenameSignatureMode(config), send: mode(rename?.peerRequestSend),
    relay: mode(rename?.peerRelayInbound), e2e: parseE2eRename(config),
  };
}

/** Observations contain only protocol judgments, never headers, keys, URLs or credentials. */
export function observePeer(area: string, verdict: string): void {
  console.info(`[floka-peer] observe ${area}: ${verdict}`);
}

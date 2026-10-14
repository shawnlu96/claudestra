/** Compatibility is opt-in; labels are selected once and never retried under another family. */
import { PEER_E2E_LABEL } from "../../peer-e2e-wire.js";

export type E2eFamily = "claudestra" | "floka";
type E2eMode = "off" | "observe" | "on";
export interface E2eRename { receive: E2eMode; send: E2eMode }
export const E2E_LABELS = {
  claudestra: { peer: PEER_E2E_LABEL, redeem: "cstra-peer-redeem-v1", response: "cstra-peer-redeem-response-v1" },
  floka: { peer: "floka-peer-e2e-v1", redeem: "floka-peer-redeem-v1", response: "floka-peer-redeem-response-v1" },
} as const;

/** A scalar enables receiving only. Sending new labels requires a separate switch. */
export function parseE2eRename(config: unknown): E2eRename {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : null;
  const value = rename && typeof rename === "object" ? (rename as { e2e?: unknown }).e2e : null;
  const gear = (v: unknown): E2eMode => v === "on" || v === "observe" ? v : "off";
  if (typeof value === "string") return { receive: gear(value), send: "off" };
  const o = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const receive = gear(o.receive);
  return { receive, send: receive === "on" ? gear(o.send) : "off" };
}

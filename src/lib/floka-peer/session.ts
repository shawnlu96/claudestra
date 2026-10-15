/** Family belongs to the authenticated session, never to a record's untrusted headers. */
import { E2E_LABELS, type E2eFamily } from "../floka-compat/e2e/families.js";
import { peerPolicy } from "./policy.js";

const families = new WeakMap<object, E2eFamily>();
export function bindSessionFamily(session: object, family: E2eFamily): void { families.set(session, family); }
export const sessionLabel = (session: object): string => E2E_LABELS[families.get(session) ?? "claudestra"].peer;
export function sessionAllowed(session: object, config?: unknown): boolean {
  const p = peerPolicy(config);
  return families.get(session) !== "floka" || (p.signature === "on" && p.e2e.receive === "on");
}
export const peerClientLabel = (d: { renameFamily?: E2eFamily }): string => E2E_LABELS[d.renameFamily ?? "claudestra"].peer;

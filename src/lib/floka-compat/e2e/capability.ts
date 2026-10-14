/** An E2E capability is signed by the pinned identity and binds the pinned encryption key too. */
import { signPurpose, verifyPurpose, type InstanceKey } from "../../instance-signature.js";
import type { SignedE2eKey } from "../../e2e-machine-key.js";
import type { E2eFamily, E2eRename } from "./families.js";

export const E2E_PROTOCOL = "floka-peer-e2e-v1";
export const E2E_CAPABILITY_TTL = 7 * 24 * 3600_000;
const PURPOSE = "claudestra-invite-pop-v1";
export interface E2ePin { instanceId: string; idk: string; ek: SignedE2eKey }
export interface E2eCapability { instanceId: string; idk: string; ek: string; version: number; protocol: string; issuedAt: number; expiresAt: number; sig: string }
const fields = (c: Omit<E2eCapability, "sig">): string[] =>
  [`${E2E_PROTOCOL}:capability`, c.instanceId, c.idk, c.ek, String(c.version), c.protocol, String(c.issuedAt), String(c.expiresAt)];
const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function issueE2eCapability(pin: E2ePin, key: InstanceKey, now = Date.now(), ttl = E2E_CAPABILITY_TTL): E2eCapability | null {
  if (pin.idk !== key.publicKey || !pin.instanceId || !whole(now) || !whole(ttl) || ttl === 0 || ttl > E2E_CAPABILITY_TTL) return null;
  const c = { instanceId: pin.instanceId, idk: pin.idk, ek: pin.ek.pub, version: pin.ek.v, protocol: E2E_PROTOCOL, issuedAt: now, expiresAt: now + ttl };
  const proof = signPurpose(PURPOSE, fields(c), key);
  return proof ? { ...c, sig: proof.sig } : null;
}

export function e2eCapabilityValid(raw: unknown, pin: E2ePin, now = Date.now()): boolean {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as E2eCapability;
  if (![c.instanceId, c.idk, c.ek, c.protocol, c.sig].every(v => typeof v === "string")) return false;
  if (!whole(c.issuedAt) || !whole(c.expiresAt) || !whole(c.version) || !pin.instanceId) return false;
  if (c.protocol !== E2E_PROTOCOL || c.instanceId !== pin.instanceId || c.idk !== pin.idk || c.ek !== pin.ek.pub || c.version !== pin.ek.v) return false;
  if (c.issuedAt > now + 300_000 || c.expiresAt <= now || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > E2E_CAPABILITY_TTL) return false;
  return verifyPurpose(pin.idk, PURPOSE, fields(c), c.sig);
}

export function planE2eSend(rename: E2eRename, pin: E2ePin, capability?: unknown, now = Date.now()): E2eFamily {
  return rename.receive === "on" && rename.send === "on" && e2eCapabilityValid(capability, pin, now) ? "floka" : "claudestra";
}

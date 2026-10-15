/** Fresh, pinned capabilities live only in this process. Restarting resets every sender to legacy. */
import { issueSignatureCapability, capabilityValid, type SignatureCapability } from "../floka-compat/signature/capability.js";
import { issueE2eCapability, e2eCapabilityValid, type E2eCapability, type E2ePin } from "../floka-compat/e2e/capability.js";
import type { LocalE2e } from "../peer-e2e-local.js";
import type { HttpPeer } from "../peers.js";
import { instanceIdSync } from "../instance-id.js";
import { peerPolicy, observePeer } from "./policy.js";

interface Capabilities { signature?: SignatureCapability; e2e?: E2eCapability }
export const pinOf = (rec: HttpPeer): E2ePin | null => rec.instanceId && !rec.disabled && rec.e2e
  ? { instanceId: rec.instanceId, idk: rec.e2e.idk, ek: rec.e2e.ek } : null;
const cacheKey = (pin: E2ePin) => JSON.stringify([pin.instanceId, pin.idk, pin.ek]);

export class PeerCapabilities {
  private readonly values = new Map<string, Capabilities>();
  admit(raw: unknown, pin: E2ePin, now = Date.now()): boolean {
    if (!raw || typeof raw !== "object") return false;
    const c = raw as Capabilities;
    const signature = capabilityValid(c.signature, { instanceId: pin.instanceId, publicKey: pin.idk }, now) ? c.signature : undefined;
    const e2e = e2eCapabilityValid(c.e2e, pin, now) ? c.e2e : undefined;
    if (!signature && !e2e) return false;
    if (this.values.size >= 2000) this.values.delete(this.values.keys().next().value!);
    this.values.set(cacheKey(pin), { signature, e2e });
    return true;
  }
  family(pin: E2ePin | null, config?: unknown, e2e = false, now = Date.now()): "claudestra" | "floka" {
    if (!pin) return "claudestra";
    const p = peerPolicy(config), c = this.values.get(cacheKey(pin));
    const capable = e2e ? e2eCapabilityValid(c?.e2e, pin, now)
      : capabilityValid(c?.signature, { instanceId: pin.instanceId, publicKey: pin.idk }, now);
    const send = e2e ? p.e2e.send : p.send;
    if (send === "observe" && capable) observePeer("send", "pinned peer supports floka");
    return capable && p.signature === "on" && send === "on" && (!e2e || (p.e2e.receive === "on" && p.send === "on")) ? "floka" : "claudestra";
  }
}

export const peerCapabilities = new PeerCapabilities();

export function learnPeerCapabilities(raw: unknown, pin: E2ePin, cache: PeerCapabilities, config?: unknown): void {
  const p = peerPolicy(config);
  if (p.e2e.receive === "on" && p.signature === "on") cache.admit(raw, pin);
  else if (p.e2e.receive === "observe" || p.signature === "observe") {
    const c = raw as Capabilities | null;
    if (e2eCapabilityValid(c?.e2e, pin)) observePeer("capability", "pinned E2E capability verified; not cached");
  }
}

/** Advertising also promises relay ingress can accept the family, so changing transport is safe. */
export function advertisePeer(local: LocalE2e, config?: unknown, iid?: string, now = Date.now()): Capabilities | undefined {
  const p = peerPolicy(config);
  if (p.signature !== "on" || p.relay !== "on") return undefined;
  const instanceId = iid ?? instanceIdSync();
  const signature = issueSignatureCapability(instanceId, local.key, now) ?? undefined;
  const e2e = p.e2e.receive === "on" ? issueE2eCapability({ instanceId, idk: local.key.publicKey, ek: local.signed }, local.key, now) ?? undefined : undefined;
  return { signature, e2e };
}

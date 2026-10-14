/** A context can only come from a complete SIGN1 signature verified against a trusted pin. */
import { verifyRequestFamilies } from "../signature/request.js";
import { verifyE2eKey } from "../../e2e-machine-key.js";
import { fromB64url } from "../../e2e/encoding.js";
import type { E2ePin } from "./capability.js";
import type { E2eFamily } from "./families.js";

export interface E2eContext { readonly family: E2eFamily; readonly pin: E2ePin; readonly path: string }
const bodies = new WeakMap<E2eContext, string>();

/** Snapshots prevent a caller changing the verified body or pin after authentication. */
export async function authenticateE2eRequest(
  headers: Readonly<Record<string, string | undefined>>, req: { method: string; path: string; body: string; route?: string }, pin: E2ePin, now = Date.now(),
): Promise<E2eContext | null> {
  const verdict = verifyRequestFamilies(headers, req, "on", now);
  if (req.method !== "POST" || verdict.status !== "ok" || verdict.publicKey !== pin.idk || !await verifyE2eKey(pin.idk, pin.ek)) return null;
  const snapshot = Object.freeze({ ...pin, ek: Object.freeze({ ...pin.ek }) });
  // route is the caller's trusted routing result; the signature still covers the full external path (including any base prefix).
  const ctx = Object.freeze({ family: verdict.family, pin: snapshot, path: req.route ?? req.path });
  bodies.set(ctx, req.body);
  return ctx;
}

/** Unauthenticated structural lookalikes and wrong operations are refused before decryption. */
export function authenticatedBody(ctx: E2eContext, path: string): unknown | null {
  const body = bodies.get(ctx);
  if (body === undefined || ctx.path !== path) return null;
  return parseJson(new TextEncoder().encode(body));
}

export function parseJson(bytes: Uint8Array | null): unknown | null {
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return null; /* Invalid authenticated plaintext is still an invalid protocol message. */ }
}

export function bytes(raw: unknown, length?: number): Uint8Array | null {
  const value = typeof raw === "string" ? fromB64url(raw) : null;
  return value && (length === undefined || value.length === length) ? value : null;
}

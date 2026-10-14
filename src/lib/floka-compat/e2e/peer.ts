/** Peer DH handshake compatibility. Records use the returned family's peer label with canonical record primitives. */
import { respond, finish, type Response, type SessionKeys } from "../../e2e/handshake.js";
import { utf8 } from "../../e2e/encoding.js";
import type { EcdhPair } from "../../e2e/primitives.js";
import { compareE2eKey, verifyE2eKey, type SignedE2eKey } from "../../e2e-machine-key.js";
import { keyFingerprint } from "../../instance-key.js";
import { E2E_HELLO_PATH, parseHello } from "../../peer-e2e-wire.js";
import { authenticatedBody, type E2eContext } from "./context.js";
import { E2E_LABELS, type E2eFamily } from "./families.js";
import type { E2ePin } from "./capability.js";

export async function respondPeer(ctx: E2eContext, local: EcdhPair, myFp: string): Promise<(Response & { family: E2eFamily }) | null> {
  const raw = authenticatedBody(ctx, E2E_HELLO_PATH);
  if (!raw) return null;
  const h = parseHello(raw);
  if ("error" in h || h.to !== myFp || h.from !== keyFingerprint(ctx.pin.idk)) return null;
  const remote = await verifyE2eKey(ctx.pin.idk, h.key);
  if (!remote || compareE2eKey(ctx.pin.ek, remote) !== "same") return null;
  try {
    const response = await respond({ fp: myFp, devId: utf8(h.from), label: E2E_LABELS[ctx.family].peer }, {
      local, remoteStatic: remote.pubBytes, ce: h.ce,
    });
    return { ...response, family: ctx.family };
  } catch { return null; /* Invalid curve points cannot establish an authenticated session. */ }
}

export async function finishPeer(
  family: E2eFamily, local: EcdhPair, ephemeral: EcdhPair, pin: E2ePin, remoteFp: string, myFp: string,
  reply: Pick<Response, "be" | "sid" | "confirm"> & { key: SignedE2eKey },
): Promise<SessionKeys | null> {
  const remote = await verifyE2eKey(pin.idk, reply.key);
  if (!remote || keyFingerprint(pin.idk) !== remoteFp || compareE2eKey(pin.ek, remote) !== "same") return null;
  return finish({ fp: remoteFp, devId: utf8(myFp), label: E2E_LABELS[family].peer }, {
    local, ephemeral, remoteStatic: remote.pubBytes, be: reply.be, sid: reply.sid, confirm: reply.confirm,
  });
}

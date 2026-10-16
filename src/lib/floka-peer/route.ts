/** Small bridge adapter keeps production policy and advertisement in the library layer. */
import type { LocalE2e } from "../peer-e2e-local.js";
import { advertisePeer } from "./capability.js";
export { peerHeaders, peerHeader, verifyPeerRequest } from "./signature.js";
export const peerRouteOptions = (local: LocalE2e) => ({ capabilities: () => advertisePeer(local) });

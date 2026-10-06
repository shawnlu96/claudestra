import { isLoopbackAddress, isPrivateAddr, isTailscaleAddr } from "../../lib/address-predicates.js";
import { fail } from "../../lib/shared-ledger-contract-v2.js";

function machineHost(host: string): boolean {
  let address = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // URL canonicalizes IPv4 aliases and IPv6 compression, including mapped IPv4 hex pairs.
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    address = [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return isLoopbackAddress(address) || isPrivateAddr(address) || isTailscaleAddr(address)
    || /^(?:0\.|169\.254\.)/.test(address) || address === "::"
    || /^(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/.test(address)
    || (!address.includes(".") && !address.includes(":"))
    || /\.(?:localhost|local|internal|lan)$/.test(address);
}

/** Only syntactically public web references are exempt from filesystem path detection; no DNS lookup. */
export function withoutPublicWebLinks(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"'`)]+/gi, raw => {
    let url: URL;
    try { url = new URL(raw); } catch { return fail(); } // Malformed references cannot safely receive the web-link exemption.
    if (url.username || url.password || machineHost(url.hostname)) fail();
    return "";
  });
}

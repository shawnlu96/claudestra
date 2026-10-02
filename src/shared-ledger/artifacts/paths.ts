import { fail, type V2Artifact } from "../../lib/shared-ledger-contract-v2.js";

// The V1 scrubber requires private machine identity and V1 field shapes. This check is identity-free
// and rejects machine references without logging content or interpreting a path as a remote URL.
function checkText(value: string): void {
  const normalized = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const withoutWebLinks = normalized.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, "");
  if (/(?:^|[^\w])(?:file|ssh|sftp|smb|vscode(?:-remote)?)\s*:/i.test(normalized)
    || /(?:^|[^\w])[A-Za-z]:[\\/]|\\\\|(?:^|[^\w.])~[\w.-]*[\\/]/u.test(normalized)
    || /(?:^|[^\w./])(?:[\w.-]+@)?[\w.-]+:(?!\/\/)[^\s]+[\\/]/u.test(normalized)
    || /(?:^|[^\w./])[\w.-]+@[\w.-]+:\S|(?:^|[^\w./])[\w.-]+:[^\s:]+\.[A-Za-z][^\s:]*/u.test(withoutWebLinks)
    || /(?:^|[^\w./~-])[\\/](?!\s|$)/u.test(withoutWebLinks)
    || /^\s*\/\s*$|["'`=]\/(?:\s|$|["'`])/u.test(normalized)) fail();
}
function decodeText(value: string): string {
  // Decode path-significant encodings without interpreting arbitrary markup or executing JSON.
  return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, unicode: string, hex: string) => String.fromCharCode(parseInt(unicode ?? hex, 16)))
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_, hex: string, decimal: string) => {
      const code = parseInt(hex ?? decimal, hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }).replace(/&(?:sol|bsol|colon);/gi, entity => ({ "&sol;": "/", "&bsol;": "\\", "&colon;": ":" })[entity.toLowerCase()]!)
    .replace(/\\\//g, "/");
}
export function assertArtifactPaths(artifact: V2Artifact): void {
  for (const value of Object.values(artifact)) {
    if (typeof value !== "string") continue;
    let decoded = value;
    // Each decoding step shortens input; bound work and reject deeper wrapping instead of accepting it.
    for (let round = 0; round < 8; round++) {
      checkText(decoded);
      const next = decodeText(decoded);
      if (next === decoded) break;
      if (round === 7) fail();
      decoded = next;
    }
  }
}

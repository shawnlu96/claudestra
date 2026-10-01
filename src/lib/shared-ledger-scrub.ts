import { redactForPeer } from "./dispatch-redact.js";
import { redactPeerPr, peerPrSecretHit, type LocalIdentity } from "./peer-pr-redact.js";
import type { Schema } from "./shared-ledger-contract-schema.js";

export interface SharedLedgerScrubContext {
  identity: LocalIdentity;
  knownSecrets?: readonly string[];
  knownAddresses?: readonly string[];
  personalValues?: readonly string[];
  commits?: ReadonlySet<string>;
}
export class SharedLedgerScrubError extends Error {
  constructor(readonly fields: readonly string[]) { super(`upload blocked at ${fields.join(", ")}`); }
}
const allowed: Record<string, readonly string[]> = {
  "$": ["type", "requestId", "projectId", "featureId", "expectedRev", "title", "description", "homeInstanceId", "patch",
    "baseVersion", "nodes", "reason", "mode", "batchId", "manifestDigest", "manifest", "sourceInstanceId",
    "previousSourceSeq", "sourceSeq", "observedAt", "tasks", "events"],
  patch: ["title", "description"], manifest: ["projectId", "sourceInstanceId", "sourceSeq", "features"],
  features: ["sourceFeatureId", "title", "description", "rev", "authorityMode", "pendingProposal", "versions", "projection"],
  versions: ["version", "nodes", "bindings", "reason"], nodes: ["key", "oneLine", "deps", "fileGlobs", "estimate"],
  bindings: ["nodeKey", "taskId"],
  projection: ["mode", "previousSourceSeq", "sourceSeq", "observedAt", "tasks", "events"],
  tasks: ["sourceTaskId", "sourceRev", "sourceSeq", "stage", "assigneeCode", "executorInstanceId", "pr", "head", "deps",
    "specSummary", "specDigest", "fullText", "steps", "asks"],
  steps: ["sourceStepId", "sourceRev", "sourceSeq", "state"], asks: ["kind", "state", "blocking"],
  events: ["sourceSeq", "sourceTaskId", "type", "at", "summary"],
};
const absolutePath = /(?:^|[\s'"`(])(?:\/[A-Za-z0-9._-]+(?:\/|\b)|[A-Za-z]:[\\/])/;
const address = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:https?|wss?):\/\/|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b/i;
/** Inspect originals before masking: detecting a secret must refuse upload even if a masker could hide it. */
export function scrubSharedLedger<T>(input: unknown, parser: Schema<T>, context: SharedLedgerScrubContext): T {
  const fields = new Set<string>();
  const commits = context.commits ?? new Set<string>();
  const known = [...(context.knownSecrets ?? []), ...(context.knownAddresses ?? []), ...(context.personalValues ?? []), context.identity.username, context.identity.hostname].filter(Boolean);
  const visit = (value: unknown, path: string, shape: string): void => {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`, shape)); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        // Unknown field names may themselves contain a secret; report their ordinal, never their spelling.
        if (!allowed[shape]?.includes(key)) fields.add(`${path}.<undeclared>`);
        else visit(child, `${path}.${key}`, key);
      }
      return;
    }
    if (typeof value !== "string") return;
    const digest = ["manifestDigest", "specDigest"].includes(shape) && /^[a-f0-9]{64}$/.test(value);
    const head = shape === "head" && commits.has(value.toLowerCase());
    if (known.some((secret) => value.includes(secret)) || address.test(value) || absolutePath.test(value)) fields.add(path);
    if (!digest && !head) {
      const peer = redactForPeer(value);
      const pr = redactPeerPr(value, context.identity, commits);
      if (peer.count || pr.count || peerPrSecretHit(value, commits)) fields.add(path);
    }
  };
  visit(input, "$", "$");
  if (fields.size) throw new SharedLedgerScrubError([...fields].sort());
  try { return parser(input); }
  catch { throw new SharedLedgerScrubError(["$.<schema>"]); } // Schema failures expose locations only, never rejected payload text.
}

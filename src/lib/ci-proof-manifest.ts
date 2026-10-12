/**
 * CI proof manifest (merge-arch-CIPROOF1): the artifact a trusted CI run writes to say what it actually tested and against
 * which subject. Strict, pure parse: a missing field, a wrong type or an unknown key rejects it, so an unknown field never
 * becomes a full proof. Verification lives in lib/ci-proof.ts; docs/architecture/ci-proof.md, tests/ci-proof.test.ts.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export const CI_PROOF_MANIFEST_VERSION = 1;
export type CiProofScope = "related" | "full";

export interface CiProofTrain {
  /** Train members in boarding order: PR number and the head the train combined. */
  members: { pr: number; head: string }[];
  combinedTree: string;
  baseline: string;
}

export interface CiProofManifest {
  version: typeof CI_PROOF_MANIFEST_VERSION;
  repo: string;
  head: string;
  base: string;
  checkout: { sha: string; tree: string };
  workflow: { path: string; sha: string };
  policyVersion: string;
  toolchain: { bun: string; lockfileDigest: string };
  tests: { universeDigest: string; selectedDigest: string; count: number };
  scope: CiProofScope;
  /** Required check names the run covered (job names in the trusted run). */
  checks: string[];
  train?: CiProofTrain;
}

type ManifestParse = { ok: true; manifest: CiProofManifest } | { ok: false; reason: string };

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const TOP_KEYS = ["version", "repo", "head", "base", "checkout", "workflow", "policyVersion", "toolchain", "tests", "scope", "checks", "train"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re?: RegExp): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && (!re || re.test(v));

/** Keys outside `allowed`, or a missing one of `required`; null = the object has exactly the keys it may have. */
function keyProblem(o: Obj, allowed: readonly string[], required: readonly string[], where: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) return `${where} 有未知字段 ${extra}`;
  const missing = required.find((k) => !(k in o));
  return missing === undefined ? null : `${where} 缺字段 ${missing}`;
}

function parseTrain(v: unknown): CiProofTrain | string {
  if (!isObj(v)) return "train 不是对象";
  const keys = keyProblem(v, ["members", "combinedTree", "baseline"], ["members", "combinedTree", "baseline"], "train");
  if (keys) return keys;
  if (!Array.isArray(v.members) || v.members.length === 0 || v.members.length > 64) return "train.members 须为 1..64 项";
  const members: CiProofTrain["members"] = [];
  for (const m of v.members) {
    if (!isObj(m) || keyProblem(m, ["pr", "head"], ["pr", "head"], "member")) return "train.members 项须恰为 {pr, head}";
    if (!Number.isSafeInteger(m.pr) || (m.pr as number) <= 0 || !str(m.head, SHA)) return "train.members 项 pr/head 非法";
    members.push({ pr: m.pr as number, head: m.head as string });
  }
  if (!str(v.combinedTree, SHA) || !str(v.baseline, SHA)) return "train.combinedTree/baseline 须为 40 位 SHA";
  return { members, combinedTree: v.combinedTree, baseline: v.baseline };
}

/** The nested objects with their exact key sets and value checks; any mismatch is the first reason returned. */
function nestedProblem(o: Obj): string | null {
  const shapes: [string, string[], (x: Obj) => boolean][] = [
    ["checkout", ["sha", "tree"], (x) => str(x.sha, SHA) && str(x.tree, SHA)],
    ["workflow", ["path", "sha"], (x) => str(x.path, WORKFLOW) && str(x.sha, SHA)],
    ["toolchain", ["bun", "lockfileDigest"], (x) => str(x.bun, /^\d+\.\d+\.\d+$/) && str(x.lockfileDigest, DIGEST)],
    ["tests", ["universeDigest", "selectedDigest", "count"],
      (x) => str(x.universeDigest, DIGEST) && str(x.selectedDigest, DIGEST) && Number.isSafeInteger(x.count) && (x.count as number) > 0],
  ];
  for (const [name, keys, ok] of shapes) {
    const x = o[name];
    if (!isObj(x)) return `${name} 不是对象`;
    const k = keyProblem(x, keys, keys, name);
    if (k) return k;
    if (!ok(x)) return `${name} 字段值非法`;
  }
  return null;
}

/** Strict parse of the artifact's JSON value (already decoded). Never throws. */
export function parseCiProofManifest(raw: unknown): ManifestParse {
  const bad = (reason: string): ManifestParse => ({ ok: false, reason: `manifest ${reason}` });
  if (!isObj(raw)) return bad("不是对象");
  const keys = keyProblem(raw, TOP_KEYS, TOP_KEYS.filter((k) => k !== "train"), "顶层");
  if (keys) return bad(keys);
  if (raw.version !== CI_PROOF_MANIFEST_VERSION) return bad(`版本 ${String(raw.version)} 不认识`);
  if (!str(raw.repo, REPO) || !str(raw.head, SHA) || !str(raw.base, SHA)) return bad("repo/head/base 非法");
  if (!str(raw.policyVersion)) return bad("policyVersion 非法");
  if (raw.scope !== "related" && raw.scope !== "full") return bad(`scope ${String(raw.scope)} 不认识`);
  const nested = nestedProblem(raw);
  if (nested) return bad(nested);
  if (!Array.isArray(raw.checks) || raw.checks.length > 64 || !raw.checks.every((c) => str(c))) return bad("checks 须为字符串列表");
  let train: CiProofTrain | undefined;
  if (raw.train !== undefined) {
    const t = parseTrain(raw.train);
    if (typeof t === "string") return bad(t);
    train = t;
  }
  const o = raw as unknown as CiProofManifest;
  return { ok: true, manifest: {
    version: CI_PROOF_MANIFEST_VERSION, repo: o.repo, head: o.head, base: o.base,
    checkout: { sha: o.checkout.sha, tree: o.checkout.tree }, workflow: { path: o.workflow.path, sha: o.workflow.sha },
    policyVersion: o.policyVersion, toolchain: { bun: o.toolchain.bun, lockfileDigest: o.toolchain.lockfileDigest },
    tests: { universeDigest: o.tests.universeDigest, selectedDigest: o.tests.selectedDigest, count: o.tests.count },
    scope: o.scope, checks: [...o.checks], ...(train ? { train } : {}),
  } };
}

/** `sha256:<hex>` of the canonical manifest: what an artifact digest must equal and what a ledger row may cite. */
export function ciProofManifestDigest(m: CiProofManifest): string {
  return `sha256:${createHash("sha256").update(canonicalJson(m)).digest("hex")}`;
}

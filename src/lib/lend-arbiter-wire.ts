/** Convergence extensions are optional so ordinary v1 orders and results keep their frozen shapes. */
import type { OrderWire } from "./order-wire.js";
import type { ResultRequest } from "./lend-wire.js";
import { refLike } from "./quote-text.js";
import type { WireResult } from "./order-wire.js";
import { peerSecretHit } from "./peer-secret-gate.js";
import { redactForPeer } from "./dispatch-redact.js";

export type ConvergenceWire =
  | { kind: "fix"; intentId: string; branch: string; peer: string; proto: 3; held: true }
  | { kind: "arbitration"; intentId: string; disputeSeq: number; findingId: string; excludedSessions: string[] };
export interface ArbiterVerdictWire { verdict: "upheld" | "overturned"; head: string; specRev: number; round: number }

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("convergence must be an object");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !(k in r))) throw new Error("unknown or missing convergence field");
  return r;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[\p{L}\p{N}_.:-]{1,200}$/u.test(v) && !peerSecretHit(v, null) && redactForPeer(v).count === 0;
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1e9;
const safeBranch = (v: unknown): v is string => typeof v === "string" && refLike(v) && v.length <= 100 &&
  !v.startsWith("-") && !v.includes("..") && !v.endsWith("/") && !v.endsWith(".lock") && !/[#:@]/.test(v);

function readConvergence(raw: unknown): { convergence?: ConvergenceWire } {
  if (!raw || typeof raw !== "object" || !("convergence" in raw)) return {};
  const value = (raw as { convergence: unknown }).convergence;
  const kind = (value as { kind?: unknown } | null)?.kind;
  const keys = kind === "fix" ? ["kind", "intentId", "branch", "peer", "proto", "held"]
    : ["kind", "intentId", "disputeSeq", "findingId", "excludedSessions"];
  const r = fields(value, keys), order = raw as OrderWire;
  if (!id(r.intentId)) throw new Error("invalid convergence intentId");
  if (kind === "fix") {
    if (order.step !== "fix" || !safeBranch(r.branch) || !id(r.peer) || r.proto !== 3 || r.held !== true) {
      throw new Error("fix requires its held proto-3 branch binding");
    }
  } else if (kind !== "arbitration" || order.step !== "review" || order.node !== "arbitration" || !number(r.disputeSeq) ||
    !id(r.findingId) || !Array.isArray(r.excludedSessions) || r.excludedSessions.length > 8 || !r.excludedSessions.every(id)) {
    throw new Error("invalid arbitration binding");
  }
  return { convergence: r as unknown as ConvergenceWire };
}

export function boundCardBranch(order: OrderWire, branch: unknown): boolean {
  const b = order.convergence;
  return b?.kind === "fix" && b.proto === 3 && b.held === true && b.branch === branch && safeBranch(branch) && order.step === "fix";
}

export function claimBranch(parsed: WireResult<OrderWire>, branch: unknown, ordinary: (v: unknown) => string): string {
  return parsed.ok && boundCardBranch(parsed.value, branch) ? branch as string : ordinary(branch);
}

export function deliverBranch(raw: unknown, ordinary: (v: unknown) => string): string {
  const r = raw as { orderId?: unknown; branch?: unknown };
  return typeof r.orderId === "string" && /:cv:\d+$/.test(r.orderId) && safeBranch(r.branch) && !r.branch.startsWith("lend/")
    ? r.branch : ordinary(r.branch);
}

export function convergenceFields(raw: unknown, fail: (path: string, why: string) => never): { convergence?: ConvergenceWire } {
  try { return readConvergence(raw); } catch (e) { return fail("convergence", (e as Error).message); }
}

export function withoutConvergence(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("convergence" in raw)) return raw;
  const { convergence: _binding, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/** The extension is validated before using the ordinary strict result parser, which still rejects every other extra key. */
function readArbiterResult(raw: unknown, ordinary: (raw: unknown) => ResultRequest): ResultRequest | null {
  if (!raw || typeof raw !== "object" || !("arbitration" in raw)) return null;
  const { arbitration, ...rest } = raw as Record<string, unknown>;
  const r = fields(arbitration, ["verdict", "head", "specRev", "round"]);
  if ((r.verdict !== "upheld" && r.verdict !== "overturned") || typeof r.head !== "string" || !/^[0-9a-f]{40}$/.test(r.head) ||
    !number(r.specRev) || !number(r.round)) throw new Error("invalid arbitration result");
  const parsed = ordinary(rest);
  if (!parsed.report.trim() || parsed.verdict.head !== r.head || parsed.verdict.findings.length ||
    parsed.verdict.verdict !== (r.verdict === "upheld" ? "changes" : "pass")) throw new Error("arbitration envelope mismatch");
  return { ...parsed, arbitration: r as unknown as ArbiterVerdictWire };
}

export function parseConvergenceResult(raw: unknown, ordinary: (raw: unknown) => ResultRequest,
  fail: (path: string, why: string) => never): ResultRequest | null {
  try {
    if (raw && typeof raw === "object" && "cancelAck" in raw) {
      const { cancelAck, ...rest } = raw as Record<string, unknown>;
      const ack = fields(cancelAck, ["clean"]);
      if (typeof ack.clean !== "boolean") throw new Error("cancelAck.clean must be boolean");
      return { ...ordinary(rest), cancelAck: { clean: ack.clean } };
    }
    return readArbiterResult(raw, ordinary);
  } catch (e) { return fail("convergence result", (e as Error).message); }
}

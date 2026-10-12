/**
 * peer-prs.json (i28-A2, docs/architecture/peer-pr-auto.md): which peers' GitHub PRs the scheduler takes as auto cards. PM writes
 * it; no name or account lives in code. Parsing is strict and all-or-nothing: an unreadable file stops the whole peer path for
 * the pass (never a partial guess), a missing file or enabled:false means zero calls. The project's repoDir / checks / deploy
 * come from scheduler.json, so the two files cannot disagree. Every reader (tick, intake CLI, bridge send) reads it fresh.
 */
import { writeJsonStateGuarded } from "./state-file.js";
import { readFileSync } from "node:fs";
import { assigneeFormatError, normalizePeerAgent } from "./ledger-checks.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { statePath } from "./paths.js";
import { FP_RE } from "./relay-protocol.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";

export const PEER_PR_CONFIG_PATH = statePath("peer-prs.json");

export interface PeerPrPeer { peer: string; fp: string; agent: string; githubLogins: string[]; authorFamily: AuthorFamily }
export interface PeerPrConfig {
  project: string;
  /** scheduler.json's repoDir for the project (never set here). */
  repoDir: string;
  fromNumber: number;
  pollSec: number;
  headSettleSec: number;
  maxOpen: number;
  maxRounds: number;
  fixTimeoutH: number;
  replyTo: string;
  extraSecurityGlobs: string[];
  peers: PeerPrPeer[];
}
export type PeerPrConfigRead = { kind: "off" } | { kind: "error"; error: string } | { kind: "on"; config: PeerPrConfig };

const PEER_NAME = /^[\w.-]{1,64}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const ONE_LINE = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,200}$/u;
const GLOB = /^[\w./*{},?[\]-]{1,200}$/;

function int(r: Record<string, unknown>, key: string, min: number, max: number, dflt?: number): number {
  const v = r[key] ?? dflt;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`peer-prs.${key} must be an integer ${min}..${max}`);
  return v as number;
}

function parsePeer(raw: unknown, i: number, seen: Set<string>): PeerPrPeer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`peer-prs.peers[${i}] must be an object`);
  const p = raw as Record<string, unknown>;
  if (typeof p.peer !== "string" || !PEER_NAME.test(p.peer)) throw new Error(`peer-prs.peers[${i}].peer must be a peers.json name`);
  if (typeof p.fp !== "string" || !FP_RE.test(p.fp)) throw new Error(`peer-prs.peers[${i}].fp must be xxxx-xxxx-xxxx-xxxx (lowercase hex)`);
  const agent = typeof p.agent === "string" ? normalizePeerAgent(p.agent) : "";
  if (!agent || assigneeFormatError("peer_agent", `${p.fp}/${agent}`)) throw new Error(`peer-prs.peers[${i}].agent is not a valid agent name`);
  if (!Array.isArray(p.githubLogins) || !p.githubLogins.length || p.githubLogins.length > 10) throw new Error(`peer-prs.peers[${i}].githubLogins must list 1..10 logins`);
  const logins = p.githubLogins.map((l) => (typeof l === "string" ? l.toLowerCase() : ""));
  for (const l of logins) {
    if (!LOGIN.test(l)) throw new Error(`peer-prs.peers[${i}].githubLogins has an invalid login`);
    if (seen.has(l)) throw new Error(`peer-prs: login ${l} is listed under two peers`);
    seen.add(l);
  }
  if (p.authorFamily !== "claude" && p.authorFamily !== "codex") throw new Error(`peer-prs.peers[${i}].authorFamily must be claude | codex`);
  return { peer: p.peer, fp: p.fp, agent, githubLogins: logins, authorFamily: p.authorFamily };
}

/** null = the file says enabled:false; throws on anything malformed or on a project scheduler.json does not run. */
export function parsePeerPrConfig(raw: unknown, scheduler: SchedulerConfig): PeerPrConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("peer-prs config must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") throw new Error("peer-prs.enabled must be boolean");
  if (!r.enabled) return null;
  if (typeof r.project !== "string" || !scheduler.enabled || !scheduler.projects[r.project]) {
    throw new Error("peer-prs.project must be a project of an enabled scheduler.json");
  }
  if (typeof r.replyTo !== "string" || !ONE_LINE.test(r.replyTo) || !r.replyTo.includes("@")) throw new Error("peer-prs.replyTo must be <agent>@<peer name>");
  const globs = r.extraSecurityGlobs ?? [];
  if (!Array.isArray(globs) || globs.length > 50 || globs.some((g) => typeof g !== "string" || !GLOB.test(g))) {
    throw new Error("peer-prs.extraSecurityGlobs must be up to 50 path globs");
  }
  if (!Array.isArray(r.peers) || !r.peers.length || r.peers.length > 8) throw new Error("peer-prs.peers must list 1..8 peers");
  const seen = new Set<string>();
  const peers = r.peers.map((p, i) => parsePeer(p, i, seen));
  if (new Set(peers.map((p) => p.peer)).size !== peers.length) throw new Error("peer-prs.peers names a peer twice");
  return {
    project: r.project, repoDir: scheduler.projects[r.project]!.repoDir,
    fromNumber: int(r, "fromNumber", 1, 10_000_000), pollSec: int(r, "pollSec", 30, 600, 60), headSettleSec: int(r, "headSettleSec", 0, 600, 90),
    maxOpen: int(r, "maxOpen", 1, 6, 2), maxRounds: int(r, "maxRounds", 1, 3, 2), fixTimeoutH: int(r, "fixTimeoutH", 1, 168, 24),
    replyTo: r.replyTo, extraSecurityGlobs: globs as string[], peers,
  };
}

/** Fresh read every call; scheduler.json is read too (its own errors count as this file's: no project, no peer path). */
export function readPeerPrConfig(path = PEER_PR_CONFIG_PATH, scheduler?: () => SchedulerConfig): PeerPrConfigRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "off" };
    return { kind: "error", error: `读不了 peer-prs.json：${(e as Error).message}` };
  }
  try {
    const config = parsePeerPrConfig(JSON.parse(text), (scheduler ?? readSchedulerConfig)());
    return config ? { kind: "on", config } : { kind: "off" };
  } catch (e) {
    return { kind: "error", error: `peer-prs.json 不合法：${(e as Error).message}` };
  }
}

/** The configured peer a GitHub login belongs to (case-insensitive), or null. */
export const peerOfLogin = (c: PeerPrConfig, login: string): PeerPrPeer | null =>
  c.peers.find((p) => p.githubLogins.includes(login.toLowerCase())) ?? null;

/** Preserve all existing fields when changing PM routing references. */
export const writePeerPrConfig = (value: Record<string, unknown>, path = PEER_PR_CONFIG_PATH): Promise<void> => writeJsonStateGuarded(path, value);

/**
 * team-project-TEAMVIS6 wiring: the home instance long-polls the center for session-page requests of its own cards and
 * returns scrubbed pages (lib/team-body-session.ts answers each one). No local HTTP endpoint, no terminal or session opening.
 * Who polls: one claim target per (center, team, instance) of an enabled mirror, signed with that mirror's service
 * credential; a project whose teamBody is off adds nothing, so a machine with every project off never polls. Observe
 * still polls so the center learns it is not open: those requests answer not_open (TEAMVIS6 验收 3).
 * A center without the extension (capability 404 / teamBody false) is not polled; it is probed again every 30 minutes.
 * Unreachable: exponential backoff 8 s → 5 min, one log line when a spell starts and one when it ends (codes only).
 * tests/team-body-session.test.ts.
 */
import { localIdentity } from "../lib/peer-pr-redact.js";
import { instanceKeySync, type InstanceKey } from "../lib/instance-key.js";
import { STATE_DIR } from "../lib/paths.js";
import { readRegistryAgents } from "../lib/registry.js";
import { listAgentSessions, readSessionHistory } from "../lib/session-history.js";
import { requestSharedLedger, SharedLedgerRemoteError } from "../lib/shared-ledger-client-transport.js";
import {
  parseTeamBodyCapability, parseTeamBodyPageClaimed, parseTeamBodyPageReturn, TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS,
  TEAM_BODY_CLAIM_WAIT_MAX_MS, TEAM_BODY_PATHS, TEAM_BODY_STATUS, type TeamBodyPageClaimed, type TeamBodyPageReturn,
} from "../lib/shared-ledger-contract-team-body.js";
import { readSharedLedgerMirrors, resolveMirrorCredential } from "../lib/shared-ledger-mirror.js";
import type { SharedLedgerLocalCredential } from "../lib/shared-ledger-mode.js";
import { homeCardOf, serveSessionPage, type ClaimScope, type SessionPageDeps, type SessionPageRequest } from "../lib/team-body-session.js";
import { teamBodyMode } from "../lib/team-body-switch.js";
import { ledgerDb } from "./ledger-feed.js";

const BACKOFF_MAX_MS = 5 * 60_000;
const PROBE_AGAIN_MS = 30 * 60_000;
/** Center calls other than the claim. */
const CALL_TIMEOUT_MS = 5_000;

export class TeamBodyUnsupported extends Error {}
export interface TeamBodyCenter {
  /** false = no extension; throws when unreachable. */
  capability: () => Promise<boolean>;
  /** Throws TeamBodyUnsupported on the center's 404. */
  claim: (waitMs: number) => Promise<TeamBodyPageClaimed>;
  send: (ret: TeamBodyPageReturn) => Promise<void>;
}
/** secrets: known secrets of every page this target returns (the bearer that signs its claims). */
export interface ClaimTarget { key: string; scope: ClaimScope; center: TeamBodyCenter; secrets: string[] }
type PageResult = TeamBodyPageReturn["result"];
export interface TeamBodyFetchDeps {
  now: () => number;
  targets: () => ClaimTarget[];
  serve: (target: ClaimTarget, request: SessionPageRequest) => Promise<PageResult>;
  log: (line: string) => void;
}
interface TargetState { supported: boolean | null; probedAt: number; failures: number; nextAt: number }
export type TeamBodyFetchState = Map<string, TargetState>;

export const teamBodyBackoffMs = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS * 2 ** Math.max(0, failures - 1));
const errorCode = (e: unknown): string => e instanceof SharedLedgerRemoteError ? `http_${e.status}` : "center_unavailable";

async function answer(target: ClaimTarget, requests: TeamBodyPageClaimed["requests"], d: TeamBodyFetchDeps): Promise<void> {
  for (const { requestId, expiresAt, ...request } of requests) {
    if (expiresAt <= d.now()) continue;
    let result: PageResult = await d.serve(target, request).catch(() => ({ kind: "refused", code: "gate_refused" }) as const);
    const ret = (r: PageResult): TeamBodyPageReturn => ({ schemaVersion: 1, requestId, sourceInstanceId: target.scope.instanceId, result: r });
    // What leaves passes the contract's own checks first; a page that fails them is refused, never trimmed here.
    try { parseTeamBodyPageReturn(ret(result)); } catch { result = { kind: "refused", code: "gate_refused" }; }
    try { await target.center.send(ret(result)); }
    catch (e) { d.log(`[team-body] 回传会话页失败：${errorCode(e)}`); }
  }
}

/**
 * One pass over the due targets. Returns how long to wait before the next pass: 0 after serving requests, otherwise what
 * is left of the idle interval (the claim's own wait counts toward it) or until the earliest backoff ends.
 */
export async function runTeamBodyFetchOnce(state: TeamBodyFetchState, d: TeamBodyFetchDeps): Promise<number> {
  const started = d.now();
  let targets: ClaimTarget[];
  try { targets = d.targets(); }
  catch (e) { d.log(`[team-body] 读不到镜像 / 凭据（${(e as Error).name}），稍后再试`); return BACKOFF_MAX_MS; }
  for (const key of state.keys()) if (!targets.some((t) => t.key === key)) state.delete(key);
  const due = targets.filter((t) => (state.get(t.key)?.nextAt ?? 0) <= started);
  const waitMs = due.length ? Math.floor(TEAM_BODY_CLAIM_WAIT_MAX_MS / due.length) : 0;
  let served = false;
  for (const target of due) {
    const s = state.get(target.key) ?? { supported: null, probedAt: 0, failures: 0, nextAt: 0 };
    state.set(target.key, s);
    try {
      if (s.supported === null || (!s.supported && d.now() - s.probedAt >= PROBE_AGAIN_MS)) {
        s.supported = await target.center.capability();
        s.probedAt = d.now();
      }
      if (!s.supported) continue;
      const claimed = await target.center.claim(waitMs);
      if (s.failures) d.log(`[team-body] 中心恢复可达（此前连续失败 ${s.failures} 次）`);
      s.failures = 0;
      s.nextAt = 0;
      if (claimed.requests.length) served = true;
      await answer(target, claimed.requests, d);
    } catch (e) {
      if (e instanceof TeamBodyUnsupported) { Object.assign(s, { supported: false, probedAt: d.now() }); continue; }
      s.failures++;
      const retry = e instanceof SharedLedgerRemoteError && e.status === 429 ? e.retryAfterMs : 0;
      s.nextAt = d.now() + Math.max(retry, teamBodyBackoffMs(s.failures));
      if (s.failures === 1) d.log(`[team-body] 领取会话页请求失败：${errorCode(e)}，退避重试（最长 ${BACKOFF_MAX_MS / 60_000} 分钟一次）`);
    }
  }
  if (served) return 0;
  const idle = Math.max(0, TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS - (d.now() - started));
  const backoffs = targets.map((t) => state.get(t.key)?.nextAt ?? 0).filter((at) => at > d.now());
  const pending = targets.some((t) => (state.get(t.key)?.nextAt ?? 0) <= d.now());
  return pending || !backoffs.length ? idle : Math.max(idle, Math.min(...backoffs) - d.now());
}

// ── live wiring ──

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = values[k];
    if (!v || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)) throw new Error("invalid path id");
    return v;
  });

function liveCenter(credential: SharedLedgerLocalCredential, key: InstanceKey): TeamBodyCenter {
  const teamId = credential.teamId;
  const call = (method: string, path: string, timeoutMs: number, payload?: unknown, success?: (status: number, body: unknown) => unknown) =>
    requestSharedLedger(credential, key, { timeoutMs }, method, path, payload, undefined, undefined, undefined, success);
  return {
    capability: async () => {
      try {
        return await call("GET", fill(TEAM_BODY_PATHS.capability, { teamId }), CALL_TIMEOUT_MS, undefined,
          (status, body) => parseTeamBodyCapability(status, body).supported) as boolean;
      } catch (e) {
        if (e instanceof SharedLedgerRemoteError && e.status === TEAM_BODY_STATUS.unsupported) return false;
        throw e;
      }
    },
    claim: async (waitMs) => {
      try {
        return await call("POST", fill(TEAM_BODY_PATHS.pageClaim, { teamId }), waitMs + CALL_TIMEOUT_MS,
          { schemaVersion: 1, sourceInstanceId: credential.instanceId, waitMs }, (_, body) => parseTeamBodyPageClaimed(body)) as TeamBodyPageClaimed;
      } catch (e) {
        if (e instanceof SharedLedgerRemoteError && e.status === TEAM_BODY_STATUS.unsupported) throw new TeamBodyUnsupported();
        throw e;
      }
    },
    send: async (ret) => {
      await call("POST", fill(TEAM_BODY_PATHS.pageReturn, { teamId, requestId: ret.requestId }), CALL_TIMEOUT_MS, ret);
    },
  };
}

/** Enabled mirrors of projects whose teamBody is not off, whose service credential is the instance the mirror pushes as. */
function liveTargets(dir = STATE_DIR): ClaimTarget[] {
  const out = new Map<string, ClaimTarget>();
  let key: InstanceKey | null | undefined; // Read (or made) only once there is something to sign.
  for (const entry of Object.values(readSharedLedgerMirrors(dir))) {
    if (!entry.enabled || teamBodyMode(entry.localProject) === "off") continue;
    const credential = resolveMirrorCredential(entry, dir);
    if (!credential || credential.instanceId !== entry.sourceInstanceId) continue;
    const k = JSON.stringify([entry.centerId, entry.teamId, credential.instanceId]);
    if (out.has(k)) continue;
    key ??= instanceKeySync(dir);
    if (!key) return [];
    out.set(k, { key: k, scope: { centerId: entry.centerId, teamId: entry.teamId, instanceId: credential.instanceId },
      center: liveCenter(credential, key), secrets: [credential.bearer] });
  }
  return [...out.values()];
}

function livePageDeps(dir = STATE_DIR): SessionPageDeps {
  const credentialOf = (e: Parameters<typeof resolveMirrorCredential>[0]) => resolveMirrorCredential(e, dir);
  return {
    card: (scope, request) => {
      const db = ledgerDb();
      return db ? homeCardOf(scope, request, readSharedLedgerMirrors(dir), (e) => credentialOf(e)?.instanceId ?? null, db) : null;
    },
    mode: (project) => teamBodyMode(project),
    readPage: async (session, before, limit) => {
      const reg = (await readRegistryAgents()).find((r) => r.name === session.agent);
      const found = (await listAgentSessions(session.agent, { cwd: reg?.cwd, currentSessionId: reg?.sessionId, runtime: reg?.runtime }))
        .find((s) => s.sessionId === session.sessionId);
      return found ? readSessionHistory(found.path, { limit, ...(before === null ? {} : { before }) }) : null;
    },
    scrub: { identity: localIdentity() },
  };
}

function liveDeps(): TeamBodyFetchDeps {
  return {
    now: Date.now,
    targets: () => liveTargets(),
    serve: (target, request) => {
      const deps = livePageDeps();
      return serveSessionPage(target.scope, request, { ...deps, scrub: { ...deps.scrub, knownSecrets: target.secrets } });
    },
    log: (line) => console.warn(line),
  };
}

let stopped: (() => void) | null = null;
/** ask-entry.ts initAskWiring: one resident claimer per bridge process. */
export function initTeamBodyFetch(d: TeamBodyFetchDeps = liveDeps()): () => void {
  if (stopped) return stopped;
  const state: TeamBodyFetchState = new Map();
  let timer: ReturnType<typeof setTimeout> | null = null, live = true;
  const tick = async () => {
    const delay = await runTeamBodyFetchOnce(state, d).catch(() => (d.log("[team-body] 领取轮次异常"), BACKOFF_MAX_MS));
    if (!live) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };
  void tick();
  stopped = () => { live = false; if (timer) clearTimeout(timer); stopped = null; };
  return stopped;
}

import { Database } from "bun:sqlite";
import { existsSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { activeWorkers, cardWorkerIndex, type CardWorker, type WorkerRegistration } from "./agent-lifecycle-store.js";
import { statePath } from "./paths.js";
import { readConfigSync } from "./config-store.js";
import { readRegistryAgentsSync, normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";
import { translateSessionLine } from "./session-source.js";
import type { Boundary } from "./ctx-boundary-decision.js";

export type CardBoundaryMode = "on" | "observe" | "off";
export const cardBoundaryMode = (raw: unknown): CardBoundaryMode => raw === "on" || raw === "off" ? raw : "observe";

/** Never migrate a ledger while deciding whether a session may receive a command. Read failures retain unknown identity. */
export function readCardSession(agent: CardSession): boolean | null {
  if (agent.status !== "active" || !agent.sessionId) return false;
  if (agent.kind === "worker") return true;
  const path = statePath("ledger.sqlite");
  if (!existsSync(path)) return false;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return isCardSession(agent, cardWorkerIndex(db), activeWorkers(db));
  } catch (error) {
    console.error("上下文卡片身份失读，保持未知：", error);
    return null;
  } finally { db?.close(); }
}

export interface CardSession {
  name: string;
  sessionId?: string;
  kind?: string;
  status?: string;
}

/** Names and tasks.agent have no session authority; an old registration must never follow a reused window. */
export function isCardSession(
  agent: CardSession,
  index: ReadonlyMap<string, CardWorker>,
  active: readonly WorkerRegistration[],
): boolean {
  if (agent.status !== "active" || !agent.sessionId) return false;
  if (agent.kind === "worker") return true;
  return (index.get(agent.name)?.links ?? []).some((link) =>
    link.source === "worker_agents" && link.sessionId === agent.sessionId
    && active.some((r) => r.state === "active" && r.agent === agent.name && r.sessionId === agent.sessionId
      && r.taskId === link.taskId && !r.reason?.startsWith("cleanup_pending:")));
}

export const CARD_BOUNDARY: Boundary = {
  policy: "card-worker", via: "global", window: 200_000, hardCap: 300_000,
  idleMs: 180_000, action: "compact", keep: null, ccWindow: 300_000,
};

export function cardActionProtected(name: string): boolean {
  if (cardBoundaryMode(readConfigSync().autoCompact?.cardWorkers) !== "on") return false;
  const agent = readRegistryAgentsSync().find((r) => r.name === name);
  return !!agent && readCardSession(agent) !== false;
}

/** Read the registry without a last-good fallback; the signature includes active registration generations (createdAt). */
export function cardIdentityStamp(name: string, sessionId: string): string | null {
  const registry = readJsonStateSync(REGISTRY_PATH);
  if (registry.status !== "ok") return null;
  const agent = normalizeRegistryAgents(registry.data).find((r) => r.name === name && r.sessionId === sessionId && r.status === "active");
  if (!agent) return null;
  let db: Database | undefined;
  try {
    const path = statePath("ledger.sqlite");
    db = existsSync(path) ? new Database(path, { readonly: true }) : undefined;
    const registrations = db ? activeWorkers(db) : [];
    if (!isCardSession(agent, db ? cardWorkerIndex(db) : new Map(), registrations)) return null;
    return JSON.stringify({ agent, registrations: registrations.filter((r) => r.agent === name && r.sessionId === sessionId) });
  } catch (error) {
    console.error("上下文发送前身份失读：", error);
    return null;
  } finally { db?.close(); }
}

export interface CardUsageSnapshot extends CardUsage { path: string; size: number; mtime: number; usageTs: number }

/** A bounded read proves the usage is not older than a later conversation. Old idle snapshots remain valid; unknown tails block. */
export function readCardUsage(path: string, runtime: string, sessionId: string, now: number): CardUsageSnapshot | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd), bytes = Math.min(before.size, 256 * 1024), buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, before.size - bytes);
    const lines = buffer.toString("utf8").split("\n");
    if (before.size > bytes) lines.shift();
    let newestConversation = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const rec = translateSessionLine(runtime, lines[i]);
      if (!rec) return null;
      const ts = Date.parse(rec.timestamp);
      if ((rec.type === "user" || rec.type === "assistant") && Number.isFinite(ts)) newestConversation = Math.max(newestConversation, ts);
      if (rec.type === "system" && rec.subtype === "compact_boundary") return null;
      const usage = rec.type === "assistant" ? rec.message?.usage : null;
      const values = usage ? [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0] : [];
      const tokens = rec.type === "system" && rec.subtype === "context_usage" ? rec.tokens
        : values.length && values.every((v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0)
          ? values.reduce((a: number, b: number) => a + b, 0) : null;
      if (typeof tokens !== "number" || tokens <= 0) continue;
      if (!Number.isFinite(ts) || ts > now || ts < newestConversation) return null;
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
      return { path, sessionId, tokens, observedAt: now, usageTs: ts, size: after.size, mtime: after.mtimeMs };
    }
    return null;
  } catch (error) {
    console.warn("上下文usage快照失读：", error);
    return null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function cardUsageUnchanged(usage: CardUsageSnapshot, now: number): boolean {
  if (now < usage.observedAt || now - usage.observedAt > 60_000) return false;
  try {
    const stat = statSync(usage.path);
    return stat.size === usage.size && stat.mtimeMs === usage.mtime;
  } catch (error) {
    console.warn("上下文usage发送前复核失读：", error);
    return false;
  }
}

export type CardUsage = { sessionId: string; tokens: number; observedAt: number };
export type CardDecision =
  | { fire: true; kind: "idle" }
  | { fire: false; reason: "usage-unknown" | "under" | "busy" | "blocked-capability" };

/** A queued command cannot bound a busy turn. Hard-cap completion needs a runtime capability, supplied by a separate node. */
export function cardSoftDecision(agent: CardSession, usage: CardUsage | null, now: number, idleSince: number | null,
  busy: boolean | null, maxAgeMs = 60_000): CardDecision {
  if (!usage || usage.sessionId !== agent.sessionId || !Number.isFinite(usage.tokens) || usage.tokens < 0
    || !Number.isFinite(usage.observedAt) || now < usage.observedAt || now - usage.observedAt > maxAgeMs) {
    return { fire: false, reason: "usage-unknown" };
  }
  if (usage.tokens >= CARD_BOUNDARY.hardCap!) return { fire: false, reason: "blocked-capability" };
  if (usage.tokens < CARD_BOUNDARY.window) return { fire: false, reason: "under" };
  if (busy !== false || idleSince === null || now - idleSince < CARD_BOUNDARY.idleMs) return { fire: false, reason: "busy" };
  return { fire: true, kind: "idle" };
}

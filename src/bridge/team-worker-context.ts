import { readRegistryAgents, agentRuntime } from "../lib/registry.js";
import { readCardSession, readCardUsage } from "../lib/ctx-boundary-card-worker.js";
import { sessionJsonlPath, findSessionJsonlBySessionId } from "../lib/session-source.js";
import { sessionTailInfo } from "../lib/session-tail.js";
import { readFileStats } from "../lib/agent-stats.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { apiJson } from "./api-respond.js";

export function workerContextProjection(used: number | null, size: number | null, today: number | null, estimated = false) {
  const valid = (n: number | null) => n !== null && Number.isFinite(n) && n >= 0 ? n : null;
  const tokens = valid(used), window = valid(size);
  return {
    used: tokens, size: window && window > 0 ? window : null, estimated, today: valid(today),
    remaining: tokens !== null && window !== null && window > 0 ? window - tokens : null,
    overRuntime: tokens !== null && window !== null && window > 0 && tokens > window,
    cardAtLimit: tokens !== null && tokens >= 300_000,
    components: { system: null, tools: null, memory: null, messages: null },
    componentSource: "JSONL usage has no prompt-component token breakdown",
    todayScope: "current-session; input + cache read + cache creation + output; local day",
    source: "existing session JSONL usage / session-matched runtime window cache",
  };
}

/** No model calls, pane reads, lifecycle writes or remote probes. Registry is rechecked after asynchronous file reads. */
export async function teamWorkerContext(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const name = q.get("agent"), expected = q.get("session");
  if (!name || name.length > 200) return apiJson(400, { error: "agent required" });
  if (q.get("peer")) return apiJson(200, { known: false, reason: "remote usage unavailable" });
  try {
    const a = (await readRegistryAgents()).find((r) => r.name === name || r.name === `agent-${name}`);
    if (!a || !a.sessionId || readCardSession(a) !== true) return apiJson(200, { known: false, reason: "worker identity unknown" });
    if (expected && expected !== a.sessionId) return apiJson(409, { known: false, reason: "session changed" });
    const runtime = agentRuntime(a);
    const path = (a.cwd ? sessionJsonlPath(runtime, a.cwd, a.sessionId) : null) ?? findSessionJsonlBySessionId(runtime, a.sessionId);
    if (!path) return apiJson(200, { known: false, reason: "session usage unavailable" });
    const tail = await sessionTailInfo(path);
    const stats = await readFileStats(path);
    const current = (await readRegistryAgents()).find((r) => r.name === a.name);
    if (!current || current.sessionId !== a.sessionId || readCardSession(current) !== true) {
      return apiJson(409, { known: false, reason: "session changed" });
    }
    const cache = readSessionCtx(a.sessionId);
    const freshCache = cache && cache.ts <= Date.now() && Date.now() - cache.ts <= 30 * 60_000 ? cache : null;
    const size = tail?.ctxWindow ?? freshCache?.window ?? null;
    const usage = readCardUsage(path, runtime, a.sessionId, Date.now());
    const used = usage?.tokens ?? (stats.contextEstimated ? stats.contextTokens : null);
    return apiJson(200, { known: true, agent: a.name, sessionId: a.sessionId,
      ...workerContextProjection(used, size, usage || stats.today.requests > 0 ? stats.today.tokens : null, stats.contextEstimated),
    });
  } catch (error) {
    console.warn("[team] worker usage unavailable:", error);
    return apiJson(503, { known: false, reason: "usage read failed" });
  }
}

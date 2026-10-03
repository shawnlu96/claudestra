/** Registered authors may be idle; only a runtime observation can keep a finished card waiting for them. */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { bareCanonicalName, normalizeRegistryAgents, type RegistryAgent } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";
import { workBoardWorkerAlive } from "./ledger-work-board-registry.js";
import { bridgeRequest } from "./bridge-client.js";
import { parseTurns } from "./acp-turn-gate.js";
import { tmuxRaw, windowTarget, piPaneIdleVerdict } from "./tmux-helper.js";
import { paneClearlyIdle, paneLooksWorking } from "./turn-state.js";
import { composerState } from "./codex-tui-submit.js";

export function finishedWriters(db: Database, task: LedgerTask, intents: readonly SchedulerIntent[], registryPath: string): {
  workers: RegistryAgent[]; reason?: string;
} {
  const sessions = db.query(`SELECT agent FROM scheduler_sessions
    WHERE taskId = ? AND role = 'author' AND transport != 'peer' AND state IN ('active','retiring')`).all(task.id) as { agent: string }[];
  const names = [task.agent, ...intents.map((i) => i.recipient), ...sessions.map((s) => s.agent)]
    .filter((n): n is string => !!n && !n.startsWith("peer:"));
  if (!names.length) return { workers: [] };
  const state = readJsonStateSync(registryPath, (value) => {
    const agents = (value as { agents?: unknown } | null)?.agents;
    return !!agents && typeof agents === "object" && !Array.isArray(agents) &&
      Object.values(agents).every((a) => !!a && typeof a === "object");
  });
  if (state.status === "corrupt") return { workers: [], reason: `本机 worker 状态无法核实：${state.error}` };
  if (state.status === "missing") return { workers: [] };
  const wanted = new Set(names.map(bareCanonicalName));
  const workers = normalizeRegistryAgents(state.data).filter((a) => wanted.has(bareCanonicalName(a.name)) && workBoardWorkerAlive(a));
  return { workers };
}

/** Session/runtime changes invalidate observations even when an agent keeps its name. */
export const finishedWorkerKey = (workers: readonly RegistryAgent[]): string => JSON.stringify(workers);

/** Fail closed on missing panes, unknown UI, startup, or an unavailable ACP host. No ledger transaction spans this await. */
export async function finishedWorkerIdle(worker: RegistryAgent): Promise<boolean> {
  if (worker.status !== "active" || !worker.sessionId || worker.acpRestartPending) return false;
  try {
    if (worker.transport === "acp") {
      const raw = await bridgeRequest({ type: "turn_status", agents: [worker.name] }, { timeoutMs: 5_000 });
      return parseTurns(raw, [worker.name])[worker.name] === "idle";
    }
    const pane = await tmuxRaw(["capture-pane", "-t", windowTarget(worker.name), "-p", "-e"], { timeoutMs: 5_000 });
    if (!pane.trim()) return false;
    const plain = pane.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (/\b[1-9]\d* (?:background terminals?|shells?)(?: still)? running\b/i.test(plain.split("\n").slice(-14).join("\n"))) return false;
    if (worker.runtime === "codex") return ["empty", "has-text"].includes(composerState(pane));
    if (worker.runtime === "pi") return piPaneIdleVerdict(plain) === "idle";
    return paneClearlyIdle(plain) && !paneLooksWorking(plain);
  } catch (error) {
    console.error(`[scheduler-lease] ${worker.name} 忙闲探测失败，保留文件锁`, error);
    return false;
  }
}

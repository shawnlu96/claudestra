/** 存量 Codex transport 迁移的纯逻辑。显式 tmux 是人工回退，永不自动覆盖。 */
import type { AcpReady } from "./readiness.js";

export interface MigratingAgent {
  runtime?: string;
  transport?: string;
  acpPending?: boolean;
  acpRestartPending?: boolean;
  acpRestartFrom?: string;
  status?: string;
}

export interface MigrationResult {
  changed: string[];
  restart: string[];
  pending: string[];
}

/** bridge 启动时没有可信的回合态；活着的旧 Codex 留在 tmux，避免 update 后直接 C-c 正在跑的回合。 */
export function deferActiveCodexMigration(agents: Record<string, MigratingAgent>): Pick<MigrationResult, "changed" | "pending"> {
  const changed: string[] = [], pending: string[] = [];
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.runtime !== "codex" || agent.status !== "active") continue;
    if (agent.transport === undefined) {
      agent.transport = "tmux";
      agent.acpPending = true;
      delete agent.acpRestartPending;
      delete agent.acpRestartFrom;
      changed.push(name);
    }
    if (agent.transport === "tmux" && agent.acpPending) pending.push(name);
  }
  return { changed, pending };
}

export function migrateCodexTransports(agents: Record<string, MigratingAgent>, ready: AcpReady, includePending = true): MigrationResult {
  const result: MigrationResult = { changed: [], restart: [], pending: [] };
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.runtime !== "codex") continue;
    if (!includePending && agent.transport === "acp") continue;
    if (!ready.ok && agent.transport === "acp") continue;
    if (agent.transport === "tmux" && (!agent.acpPending || !includePending)) continue;
    const before = agent.transport;
    const pending = agent.acpPending === true;
    if (ready.ok) {
      agent.transport = "acp";
      delete agent.acpPending;
    } else {
      agent.transport = "tmux";
      agent.acpPending = true;
      result.pending.push(name);
    }
    if (before !== agent.transport || pending !== (agent.acpPending === true)) {
      result.changed.push(name);
      if (agent.status === "active" && (before === "acp" ? "acp" : "tmux") !== agent.transport) {
        agent.acpRestartFrom = before ?? "tmux";
        agent.acpRestartPending = true;
      }
    }
    if (agent.acpRestartPending && agent.status === "active") result.restart.push(name);
  }
  return result;
}

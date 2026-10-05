import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonState, reportCorrupt, writeJsonStateGuarded } from "./state-file.js";

interface ShellResult {
  id: string;
  startedAt: number;
  lastGrowth: number;
  status: "done" | "unknown";
  exitCode: number | null;
  durationMs: number;
}
interface ShellIdentity { agentName: string; sessionId: string; id: string; startedAt: number; lastGrowth: number; exitCode: number | null }
export interface ShellResultSnapshot extends Record<string, unknown> {
  id: string; kind: "shell"; title: string; startedAt: number; lines: string[];
  progress: { startedTs: number; lastTs: number };
  end: { status: "done" | "unknown"; exitCode: number | null; durationMs: number };
}
const LIMIT = 8;
const valid = (data: unknown): data is ShellResult[] => Array.isArray(data) && data.length <= LIMIT && data.every((r) =>
  r && Object.keys(r).length === 6 && typeof r.id === "string" && r.id.length <= 200 && Number.isFinite(r.startedAt) && Number.isFinite(r.lastGrowth) &&
  Number.isFinite(r.durationMs) && (r.status === "unknown" && r.exitCode === null || r.status === "done" && Number.isSafeInteger(r.exitCode)),
);
const resultPath = (agent: string, session: string) => statePath("bg-shell-results", createHash("sha256").update(JSON.stringify([agent, session])).digest("hex") + ".json");

/** Only genuinely tracked tasks are journaled, so baseline outputs never become new tasks after a restart.
 * Unknown records preserve uncertainty if the bridge dies while a task runs. No output text is persisted.
 * Eight records per agent-session match the existing card bound; elapsed time never erases a result. */
export class ShellResults {
  private scopes = new Map<string, ShellResult[]>();
  private current = new Map<string, string>();

  async select(agent: string, session: string): Promise<void> {
    if (this.current.get(agent) !== resultPath(agent, session)) await this.load(agent, session);
  }

  async load(agent: string, session: string): Promise<void> {
    const path = resultPath(agent, session);
    const r = await readJsonState(path, valid);
    if (r.status === "corrupt") reportCorrupt(path, r.error, "bg-shell-results");
    this.current.set(agent, path);
    this.scopes.set(path, r.status === "ok" ? r.data as ShellResult[] : []);
  }

  async remember(act: ShellIdentity, durationMs = 0, status: "done" | "unknown" = "unknown"): Promise<void> {
    const row: ShellResult = { id: act.id, startedAt: act.startedAt, lastGrowth: act.lastGrowth, status, exitCode: status === "done" ? act.exitCode : null, durationMs };
    const path = resultPath(act.agentName, act.sessionId);
    const rows = this.scopes.get(path) ?? [];
    const next = [...rows.filter((r) => r.id !== act.id), row].slice(-LIMIT);
    this.scopes.set(path, next);
    if (!this.current.has(act.agentName)) this.current.set(act.agentName, path);
    try {
      await mkdir(dirname(path), { recursive: true });
      const lock = await acquireLock(path + ".lock");
      if (!lock) throw new Error("result lock unavailable; refusing an unlocked write");
      try {
        const disk = await readJsonState(path, valid);
        const merged = disk.status === "ok" ? [...(disk.data as ShellResult[]).filter((r) => r.id !== act.id), row].slice(-LIMIT) : next;
        await writeJsonStateGuarded(path, merged, { mode: 0o600, validate: valid });
        this.scopes.set(path, merged);
      } finally {
        lock.release();
      }
    } catch (error) {
      console.error(`bg shell result persistence failed (${act.agentName}):`, error);
    }
  }

  snapshots(agent: string): ShellResultSnapshot[] {
    return (this.scopes.get(this.current.get(agent) ?? "") ?? []).map((r) => ({
      id: r.id, kind: "shell", title: `🐚 bg shell ${r.id}`, startedAt: r.startedAt,
      lines: r.status === "done" ? [`[exited with code ${r.exitCode}]`] : [],
      progress: { startedTs: r.startedAt, lastTs: r.lastGrowth },
      end: { status: r.status, exitCode: r.exitCode, durationMs: r.durationMs },
    }));
  }
}

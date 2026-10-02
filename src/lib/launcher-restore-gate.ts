/** Persistent dead-agent restore limits; manager list supplies lifecycle and liveness observations. */
import { mkdirSync, rmdirSync, statSync } from "fs";
import { dirname } from "path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { restartFailureReason, type RestartRunOutcome } from "./restart-result.js";
import { t } from "./i18n.js";

interface Agent {
  name: string;
  status?: string;
  idle?: boolean;
  runtime?: string;
  cwd?: string;
  created?: string;
  sessionId?: string;
  channelId?: string;
}
interface Entry {
  generation: string;
  failures: number;
  missingAlert: boolean;
  failureAlert: boolean;
  lastFailureAlert?: number;
}
interface State { version: 1; agents: Record<string, Entry> }
interface Options {
  path?: string;
  alert: (text: string) => Promise<boolean>;
  log?: (text: string) => void;
}
const generation = (a: Agent) => JSON.stringify([a.created, a.sessionId, a.channelId, a.cwd]);
const fresh = (a: Agent): Entry => ({ generation: generation(a), failures: 0, missingAlert: false, failureAlert: false });

function validState(value: unknown): boolean {
  const s = value as State | null;
  return !!s && s.version === 1 && !!s.agents && typeof s.agents === "object" && !Array.isArray(s.agents)
    && Object.values(s.agents).every((e) => e && typeof e.generation === "string"
      && Number.isInteger(e.failures) && e.failures >= 0 && e.failures <= 3
      && typeof e.missingAlert === "boolean" && typeof e.failureAlert === "boolean"
      && (e.lastFailureAlert === undefined || (Number.isFinite(e.lastFailureAlert) && e.lastFailureAlert >= 0)));
}

function directoryExists(cwd: string, log: (text: string) => void): boolean {
  try { return statSync(cwd).isDirectory(); }
  catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return false;
    // Unknown filesystem errors must not stop healthy agents in the same wave.
    // Let manager attempt the restart; its failure then counts toward the limit.
    log(`launcher restore gate: cannot inspect ${cwd}: ${String(e)}`);
    return true;
  }
}

export class LauncherRestoreGate {
  private readonly path: string;
  private readonly log: (text: string) => void;
  private faultNotified = false;
  constructor(private readonly options: Options) {
    this.path = options.path ?? statePath("launcher-restore-gate.json");
    this.log = options.log ?? console.error;
  }

  private async transaction<T>(update: (state: State) => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = await acquireLock(`${this.path}.lock`, 1000);
    if (!lock) throw new Error("launcher restore gate: state lock unavailable; skipping restore");
    try {
      const read = readJsonStateSync(this.path, validState);
      if (read.status === "corrupt") throw new Error(`launcher restore gate: ${read.error}`);
      const state: State = read.status === "missing" ? { version: 1, agents: {} } : read.data as State;
      const before = JSON.stringify(state);
      const result = update(state);
      if (JSON.stringify(state) !== before) {
        writeJsonAtomicSync(this.path, state, { mode: 0o600, commitIf: () => lock.held() });
      }
      this.clearFault();
      return result;
    } finally { lock.release(); }
  }

  private clearFault(): void {
    this.faultNotified = false;
    try { rmdirSync(`${this.path}.fault-notified`); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`launcher restore gate: cannot clear fault alert: ${String(e)}`);
    }
  }

  private async stateFault(error: unknown): Promise<string> {
    const reason = `launcher restore gate: state unavailable: ${String(error)}`;
    this.log(reason);
    if (this.faultNotified) return reason;
    this.faultNotified = true;
    // Claim independently of the corrupt/busy state; launcher restarts must not repeat the alert.
    try { mkdirSync(`${this.path}.fault-notified`, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return reason;
      this.log(`launcher restore gate: cannot persist fault alert: ${String(e)}`);
    }
    await this.announce([t(
      `⚠️ launcher 自动恢复状态不可用，已暂停自动恢复：${this.path}。请检查文件与锁并修复；后续巡检会重试。${String(error).slice(0, 200)}`,
      `⚠️ launcher auto-restore state unavailable: ${this.path}. Check and repair the file/lock; later checks will retry. ${String(error).slice(0, 200)}`,
    )]);
    return reason;
  }

  private entry(state: State, a: Agent): Entry {
    if (!Object.hasOwn(state.agents, a.name) || state.agents[a.name].generation !== generation(a)) {
      Object.defineProperty(state.agents, a.name, { value: fresh(a), enumerable: true, configurable: true, writable: true });
    }
    return state.agents[a.name];
  }

  private stopped(a: Agent, e: Entry, alerts: string[]): void {
    if (e.failureAlert) return;
    e.failureAlert = true;
    alerts.push(t(
      `⚠️ launcher 已停止自动恢复 ${a.name}：连续恢复失败 3 次。请检查后手动 manager restart ${a.name}，或 manager kill ${a.name}。`,
      `⚠️ launcher stopped auto-restoring ${a.name} after 3 consecutive failures. Investigate, then manager restart ${a.name}, or manager kill ${a.name}.`,
    ));
  }

  private async announce(alerts: string[]): Promise<void> {
    // Persist the claim before sending: launcher crashes must not re-send a control alert.
    // notify() records undelivered messages; a failed delivery does not re-enable restores.
    for (const text of alerts) {
      this.log(text);
      try {
        if (!await this.options.alert(text)) this.log("launcher restore gate: alert undelivered");
      } catch (e) { this.log(`launcher restore gate: alert failed: ${String(e)}`); }
    }
  }

  async select<T extends Agent>(agents: T[]): Promise<T[]> {
    const alerts: string[] = [];
    let selected: T[];
    try { selected = await this.transaction((state) => {
      const names = new Set(agents.map((a) => a.name));
      for (const name of Object.keys(state.agents)) if (!names.has(name)) delete state.agents[name];
      return agents.filter((a) => {
        // An active process may be a timed-out launch. Claude's idle prompt proves readiness;
        // hook-based runtimes report idle unconditionally, so that is not evidence for them.
        if (a.status !== "dead") {
          if (Object.hasOwn(state.agents, a.name)) {
            const e = this.entry(state, a);
            if (e.missingAlert && directoryExists(a.cwd || process.env.HOME || "/", this.log)) e.missingAlert = false;
            if (a.status === "active" && a.runtime === "claude-code" && a.idle === true) {
              e.failures = 0; e.failureAlert = false; delete e.lastFailureAlert;
            }
          }
          return false;
        }
        const e = this.entry(state, a);
        if (e.failures >= 3) { this.stopped(a, e, alerts); return false; }
        // Match manager restart's fallback for legacy records with no cwd.
        const cwd = a.cwd || process.env.HOME || "/";
        if (directoryExists(cwd, this.log)) { e.missingAlert = false; return true; }
        if (!e.missingAlert) {
          e.missingAlert = true;
          alerts.push(t(
            `⚠️ launcher 跳过恢复 ${a.name}：工作目录不存在：${cwd}。请恢复目录，或 manager kill ${a.name}。`,
            `⚠️ launcher skipped ${a.name}: working directory missing: ${cwd}. Restore the directory, or manager kill ${a.name}.`,
          ));
        }
        return false;
      });
    }); } catch (e) { await this.stateFault(e); return []; }
    await this.announce(alerts);
    return selected;
  }

  async restart(a: Agent, run: () => Promise<RestartRunOutcome>): Promise<string | null> {
    // Reserve before spawning so a post-run storage error or crash cannot erase the attempt.
    // Release the state lock before the slow manager restart.
    try {
      const allowed = await this.transaction((state) => {
        const e = this.entry(state, a);
        if (e.failures >= 3) return false;
        e.failures++;
        return true;
      });
      if (!allowed) return "launcher restore gate: restore limit reached";
    } catch (e) { return this.stateFault(e); }
    let reason: string | null;
    try { reason = restartFailureReason(await run()); }
    catch (e) { reason = String(e) || "restart failed"; }
    const alerts: string[] = [];
    try {
      await this.transaction((state) => {
        const e = this.entry(state, a);
        if (!reason) { e.failures = 0; e.failureAlert = false; delete e.lastFailureAlert; }
        else if (e.failures >= 3) this.stopped(a, e, alerts);
        else if (e.lastFailureAlert === undefined || Date.now() - e.lastFailureAlert >= 30 * 60_000) {
          e.lastFailureAlert = Date.now();
          alerts.push(t(
            `⚠️ launcher 恢复 ${a.name} 失败：${reason.slice(0, 300)}。请检查，或手动 manager restart ${a.name}。`,
            `⚠️ launcher failed to restore ${a.name}: ${reason.slice(0, 300)}. Investigate, or run manager restart ${a.name}.`,
          ));
        }
      });
    } catch (e) {
      // Return the actual outcome so the caller completes the wave and its cooldown.
      alerts.length = 0; // A failed commit did not persist these claims; the next check can claim them.
      await this.stateFault(e);
    }
    await this.announce(alerts);
    return reason;
  }
}

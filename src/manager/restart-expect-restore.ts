/** Automatic restore observations are separate from the supervisor's strict expect wire. */
import { checkAcpReady } from "../lib/acp/readiness.js";
import { selectedCodexAdapter } from "../lib/acp/codex-compat.js";
import { isSandbox } from "../lib/sandbox.js";
import { managedFor } from "../lib/runtimes/index.js";
import type { WindowOps } from "../lib/runtimes/types.js";
import { restartExceptionResult } from "../lib/restart-result.js";
import { REGISTRY_PATH } from "../lib/registry.js";
import { tmuxRaw, tmuxRawStrict, tmuxSendLine, type SwitchIO, windowHasChildProcess, MASTER_SESSION } from "../lib/tmux-helper.js";
import { probeDeadShellWindows } from "./list-dead-probe.js";

export interface RestoreRow {
  sessionId?: string; channelId?: string; created?: string; cwd?: string;
  runtime?: string; transport?: string; status?: string; pending?: unknown;
}
interface RestoreWire { v: 1; agent: string; identity: string; windows: string[] }
export interface RestoreModelOps { target: string; io: SwitchIO; sent(): boolean }
export interface RestoreDeps {
  registry(): Promise<Record<string, RestoreRow>>;
  windows(): Promise<Record<string, string[]>>;
  dead(name: string): Promise<boolean>;
  children(windowId: string): Promise<boolean | null>;
}
const identity = (r: RestoreRow) => JSON.stringify([
  r.sessionId, r.channelId, r.created, r.cwd, r.runtime, r.transport, r.status, r.pending,
]);
const live: RestoreDeps = {
  registry: async () => {
    const value = await Bun.file(REGISTRY_PATH).json();
    if (!value?.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new Error("invalid registry");
    return value.agents;
  },
  windows: async () => {
    const out = await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}\t#{window_id}"]);
    const result: Record<string, string[]> = Object.create(null);
    for (const line of out.trim().split("\n")) {
      const [name, id] = line.split("\t");
      if (!name || !/^@\d+$/.test(id ?? "")) throw new Error("invalid window inventory");
      (result[name] ??= []).push(id);
    }
    return result;
  },
  children: windowHasChildProcess,
  dead: async (name) => (await probeDeadShellWindows([name])).has(name),
};

/** Take the window identity before the list probe awaits; an unavailable inventory produces no restore authority. */
export async function restoreObservations(rows: Record<string, RestoreRow>, deps: RestoreDeps = live): Promise<Record<string, string>> {
  try {
    const windows = await deps.windows();
    return Object.fromEntries(Object.entries(rows).map(([agent, row]) => [agent,
      JSON.stringify({ v: 1, agent, identity: identity(row), windows: windows[agent] ?? [] } satisfies RestoreWire),
    ]));
  } catch (e) { console.error(`[restore] cannot observe identity: ${String(e)}`); return {}; }
}

function parse(raw: string, target: string): RestoreWire {
  if (new TextEncoder().encode(raw).length > 2048) throw new Error("restore observation exceeds 2048 bytes");
  const w = JSON.parse(raw);
  if (w?.v !== 1 || w.agent !== target || typeof w.identity !== "string" || !Array.isArray(w.windows)
    || w.windows.length > 1 || !w.windows.every((id: unknown) => typeof id === "string" && /^@\d+$/.test(id))
    || Object.keys(w).sort().join(",") !== "agent,identity,v,windows") throw new Error("invalid restore observation");
  const id = JSON.parse(w.identity);
  if (!Array.isArray(id) || id.length !== 8 || !id.slice(0, 2).every((v) => typeof v === "string" && !!v)
    || !id.slice(0, 7).every((v) => v === null || (typeof v === "string" && !/[\x00-\x1f\x7f]/.test(v)))
    || id[6] !== "active" || id[7] !== null) {
    throw new Error("invalid restore identity");
  }
  return w;
}

/** Called with the restart mutex held. Probe awaits, so both registry and window identities must match afterwards too. */
export async function restoreSkip(target: string, raw: string | undefined, deps: RestoreDeps = live, initial?: RestoreRow) {
  if (raw === undefined) return null;
  try {
    const want = parse(raw, target);
    if (initial && identity(initial) !== want.identity) throw new Error("restart snapshot identity changed");
    const matches = async () => {
      const windows = await deps.windows();
      const row = (await deps.registry())[target];
      return !!row && !!row.sessionId && !!row.channelId && row.status === "active" && !row.pending
        && identity(row) === want.identity && JSON.stringify(windows[target] ?? []) === JSON.stringify(want.windows);
    };
    if (!await matches()) throw new Error("restore identity/state changed");
    if (want.windows.length && !await deps.dead(target)) throw new Error("restored or liveness unknown");
    if (!await matches()) throw new Error("identity changed during probe");
    return null;
  } catch (e) {
    const reason = String(e);
    return { name: target, ok: false as const, skipped: reason, error: reason };
  }
}

/** Only flags preceding the explicit single target can grant an automatic restore. */
export function restoreArg(args: string[]): string | undefined {
  const end = args.indexOf("--");
  const i = (end < 0 ? args : args.slice(0, end)).indexOf("--restore-expect");
  return i < 0 ? undefined : end !== 2 || i !== 0 || !args[end + 1] || args.length !== end + 2 ? "" : args[1] ?? "";
}

export const restoreWindowIds = (raw: string, target: string): string[] => parse(raw, target).windows;
class RestoreSkipped extends Error {}

/** Pin every launch operation to the selected ID and recheck after preparation awaits, immediately before mutation. */
export function restoreLaunchGuard(target: string, raw: string, windowId: string, deps: RestoreDeps = live, send: typeof tmuxSendLine = tmuxSendLine) {
  const want = parse(raw, target);
  const authority = JSON.stringify({ ...want, windows: [windowId] });
  let launched = false;
  let skipped: Awaited<ReturnType<typeof restoreSkip>> = null;
  const check = async (phase?: "cancel" | "literal" | "enter") => {
    if (skipped) throw new RestoreSkipped(skipped.skipped);
    const probe = launched ? async () => true : phase === "enter" ? async () => await deps.children(windowId) === false : deps.dead;
    skipped = await restoreSkip(target, authority, { ...deps, dead: probe });
    if (skipped) throw new RestoreSkipped(skipped.skipped);
  };
  const wrap = (win: WindowOps): WindowOps => ({
    ...win,
    capture: async (lines) => { if (launched) await check(); return win.capture(lines); },
    sendLine: async (text) => { await send(win.target, text, 100, true, check); launched = true; },
    sendLiteral: async (text) => { await check(); await win.sendLiteral(text); },
    sendKey: async (key) => { await check(); await win.sendKey(key); },
    sendEscape: async () => { await check(); await win.sendEscape(); },
    setOption: async (key, value) => { await check(); return win.setOption(key, value); },
  });
  const model = (win: WindowOps): RestoreModelOps => {
    let sent = false;
    const lose = (error: unknown): never => {
      const reason = `model capture unknown: ${String(error)}`;
      skipped ??= { name: target, ok: false, skipped: reason, error: reason };
      throw new RestoreSkipped(skipped.skipped);
    };
    return { target: windowId, sent: () => sent, io: {
      capture: async (_t, lines) => {
        await check();
        try {
          const pane = await tmuxRawStrict(["capture-pane", "-t", windowId, "-p", "-J", "-S", `-${lines}`]);
          return pane.trim() ? pane : lose("empty capture");
        } catch (e) { return lose(e); }
      },
      sendLine: async (_t, text, delay) => { await send(windowId, text, delay, false, check); sent = true; },
      sendKey: async (_t, key) => { await check(); await tmuxRaw(["send-keys", "-t", windowId, key]); },
      sleep: win.sleep,
    } };
  };
  return { wrap, model, skipped: () => skipped };
}

export function restoreExceptionResult(target: string, error: unknown) {
  const result = restartExceptionResult(target, error);
  return error instanceof RestoreSkipped ? { ...result, skipped: error.message } : result;
}

/** Retain managedForRestart's runtime/ACP admission checks without retire, install, switch or fallback side effects. */
export async function restoreAdapter(target: string, info: RestoreRow, deps = { sandbox: isSandbox, ready: checkAcpReady }, raw?: string) {
  if (info.runtime === "codex" && info.transport !== "acp" && deps.sandbox()) return null;
  const adapter = managedFor(info.runtime, info.transport);
  if (adapter && info.runtime === "codex" && info.transport === "acp") {
    const ready = await deps.ready(false, { selected: () => selectedCodexAdapter(target) });
    if (!ready.ok) {
      const skip = await restoreSkip(target, raw);
      if (skip) throw new RestoreSkipped(skip.skipped);
      throw new Error(ready.reason);
    }
  }
  return adapter;
}

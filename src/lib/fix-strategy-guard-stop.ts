/** The manager child reuses the admitted swap pins; reopening the gate from current rows would authorize a takeover. */
import { readFileSync } from "node:fs";
import { REGISTRY_PATH } from "./registry.js";
import { Database } from "bun:sqlite";
import { swapGate, type SwapPins } from "./fix-strategy-guard.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { SchedulerSession } from "./scheduler-sessions.js";
import { assertSchedulerLease } from "./scheduler-lease-env.js";

/** Read-only and fail closed: no migration, no receipt, no restoration of a stale scheduler authorization. */
function verifyFixStop(raw: string | undefined, agent: string, sessionId: string): string | null {
  if (raw === undefined) return null;
  let db: Database | undefined;
  try {
    assertSchedulerLease();
    const wire = JSON.parse(raw) as { v: number; path: string; intent: SchedulerIntent; old: SchedulerSession; pins: SwapPins };
    if (wire.v !== 1 || typeof wire.path !== "string" || !wire.path || !wire.intent || !wire.pins ||
      !wire.old || wire.old.agent !== agent || wire.old.sessionId !== sessionId || wire.intent.action !== "fix_swap") {
      return "换作者停止授权不可核实";
    }
    db = new Database(wire.path, { readonly: true, strict: true });
    const ledger = db;
    return ledger.transaction(() => swapGate(ledger, wire.intent, wire.old, undefined, wire.pins)()?.reason ?? null)();
  } catch (e) { return `换作者停止授权读取失败：${String(e)}`; } finally { db?.close(); }
}

/** Preserve pending and case variants; normalized inventory intentionally loses both and cannot authorize a stop. */
export function readStopRegistry<T>(path = REGISTRY_PATH): T {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || !raw.agents || typeof raw.agents !== "object" || Array.isArray(raw.agents)) throw new Error("停止身份 registry 不可核实");
  return raw as T;
}

type IdentityRow = { sessionId?: string; pending?: { op: string } };
type IdentityRegistry = { agents: Record<string, IdentityRow> };
/** Run after the final window query returns; synchronous registry and ledger reads end directly at the effect invocation. */
export function verifyStopEdge(snapshot: () => IdentityRegistry, name: string, sessionId: string,
  windows: string[], expected: string[] | undefined, own: unknown, raw: string | undefined): string | null {
  try {
    const reg = snapshot(), info = reg.agents[name];
    if (!info) return "registry 里已没有这个条目";
    if (info.sessionId !== sessionId) return "条目现在跑的是另一个会话";
    if (info.pending && JSON.stringify(info.pending) !== JSON.stringify(own)) return `条目带未完成的 ${info.pending.op}`;
    if (Object.keys(reg.agents).some((key) => key !== name && key.toLowerCase() === name.toLowerCase())) return "registry 有大小写变体，归属不明";
    if (expected && windows.join() !== expected.join()) return "窗口集合已变化，不关窗口";
    return verifyFixStop(raw, name, sessionId);
  } catch (e) { return `停止身份读取失败：${String(e)}`; }
}

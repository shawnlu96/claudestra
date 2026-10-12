/**
 * A fix swap's standing permission, read fresh from the ledger at every effect edge (archive / kill / create and each receipt).
 * The scheduler lease only says this process is still the scheduler; a submitted intent says the swap was once allowed. Neither
 * says it still is: PM may take the card over, move its head / spec, rebind the author or lend the old session to another card
 * while an inventory or a manager child is awaited. Callers invoke the gate synchronously, with no await before the effect.
 * Tests: tests/fix-strategy-audit-gate.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import type { RegistryAgent } from "./registry.js";
import { getSchedulerSession, type SchedulerSession } from "./scheduler-sessions.js";

/**
 * takeover = PM's manual mode; drift = card / workflow / intent moved; binding = the author is no longer the pinned one;
 * session = the registry runs another session under the old author's name.
 */
type SwapHaltKind = "takeover" | "drift" | "binding" | "shared" | "session";
export interface SwapHalt { halted: SwapHaltKind; reason: string }
/** `"stopped"` = the caller is past the old author's stop (create, bind): the old session must also still be stopped. */
export type SwapGate = ((after?: "stopped") => SwapHalt | null) & { stopWire?: string };
export interface SwapPins { flowRev: number | null; owned: string | null; bound: string }

export const SHARED_AUTHOR = "旧作者会话还被其他卡或审查绑定使用，不能停止";
const STOPPED = "换作者停止推进，不归档、不停止、不新建";
const OPEN: readonly string[] = ["pending", "submitted"];

const halt = (halted: SwapHaltKind, why: string): SwapHalt => ({ halted, reason: `${why}；${STOPPED}` });
export const reboundHalt = (): SwapHalt => halt("binding", "作者绑定已变化，现绑定不是本意图要换的会话");
/** The whole persisted ownership, agent and session id: a binding moved to another agent keeps the id and is still not the pinned author. */
export const sameAuthor = (pinned: Record<string, unknown>, now: { agent: string; sessionId: string } | null): boolean =>
  pinned.sessionId === (now?.sessionId ?? null) && (pinned.agent === undefined || pinned.agent === (now?.agent ?? null));

/** Another unfinished card, or another role of this card, still uses the agent: stopping it would stop that work. */
export const sharedHolder = (db: Database, agent: string, taskId: string): boolean =>
  !!db.query(`SELECT taskId FROM scheduler_sessions WHERE agent = ? AND state != 'retired'
    AND (taskId != ? OR role != 'author') UNION SELECT id FROM tasks WHERE agent = ? AND id != ? AND stage NOT IN ('verified','done','cancelled')`)
    .get(agent, taskId, agent, taskId);

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/**
 * The final stop of a fix swap: `manager kill <name> --session <id>` (manager/agent-kill.ts killSession). The manager child holds
 * the agent's restart lock and re-reads identity and the admitted ownership pins after its own inventory awaits and before
 * each effect. A session replacement or PM takeover while the child runs cannot authorize the next effect.
 */
export const sessionStop = (manager: Manager) => (old: { agent: string; sessionId: string }, gate?: SwapGate): Promise<Record<string, unknown>> =>
  manager("kill", old.agent, "--session", old.sessionId, ...(gate ? ["--fix-stop", gate.stopWire ?? ""] : []));
/** The stop port's own refusal (identity mismatch, restart lock held): neither "stopped" nor a kill to repeat by name. The swap waits. */
export const stopRefusal = (r: Record<string, unknown>): string | null => typeof r.refused !== "string" ? null
  : `最终停止端口拒停（${r.refused === "restart-lock" ? "restart 锁被占" : "会话身份不符"}）：${String(r.error ?? r.refused)}；不按名字 kill、不新建`;

/** The registry's own answer, read synchronously: the name must not run any session but the pinned one. An absent row is not a new session. */
const oldSession = (registry: () => RegistryAgent[], old: { agent: string; sessionId: string }, after?: "stopped"): SwapHalt | null => {
  const row = registry().find((r) => r.name === old.agent);
  if (row && row.sessionId !== old.sessionId) return halt("session", "旧作者名下已是另一个会话");
  return after && row && row.status !== "stopped" ? { halted: "session", reason: "旧作者会话又在运行，不记停止回执、不新建、不改绑" } : null;
};

const owner = (t: LedgerTask): string => JSON.stringify([t.agent, t.assigneeKind, t.assignee]);
const session = (s: SchedulerSession | null): string => JSON.stringify(s && [s.agent, s.sessionId, s.state, s.transport]);

/**
 * Pins what this step saw when it was admitted (workflow rev, owner, the author binding it means to replace) next to what the
 * intent itself pins (task rev, spec, head). The returned gate is null only while all of it still holds. With `registry` it also
 * reads the actual session under the old author's name: the ledger binding does not move when PM starts a new session there.
 */
export function swapGate(db: Database, intent: SchedulerIntent, old: SchedulerSession | null, registry?: () => RegistryAgent[], pinned?: SwapPins): SwapGate {
  const admitted = getTask(db, intent.taskId), flowRev = getWorkflow(db, intent.taskId)?.rev ?? null;
  const owned = admitted ? owner(admitted) : null, bound = session(old);
  const pins = pinned ?? { flowRev, owned, bound };
  const gate: SwapGate = (after) => {
    const task = getTask(db, intent.taskId), flow = getWorkflow(db, intent.taskId), now = getIntent(db, intent.id);
    if (flow && flow.mode !== "auto") return halt("takeover", `PM 已接管（流程 ${flow.mode}）`);
    if (!task || !flow || flow.rev !== pins.flowRev || flow.specRev !== task.specRev) return halt("drift", "卡的流程版本已变化");
    if (task.stage !== "fix" || task.rev !== intent.taskRev || task.specRev !== intent.specRev || task.headSHA !== intent.head) {
      return halt("drift", "卡的阶段 / 版本 / 规格 / head 已变化");
    }
    if (!now || !OPEN.includes(now.status) || now.taskId !== intent.taskId || now.taskRev !== intent.taskRev || now.specRev !== intent.specRev ||
      now.head !== intent.head || now.action !== intent.action || now.project !== intent.project || now.recipient !== intent.recipient ||
      now.node !== intent.node || now.templateVersion !== intent.templateVersion || now.eventSeq !== intent.eventSeq ||
      now.causalSeq !== intent.causalSeq) return halt("drift", "换作者意图已结算或被改写");
    if (owner(task) !== pins.owned) return halt("binding", "卡的负责人已变化");
    if (session(getSchedulerSession(db, task.id, "author")) !== pins.bound) return reboundHalt();
    if (old && sharedHolder(db, old.agent, task.id)) return { halted: "shared", reason: SHARED_AUTHOR };
    return old && registry ? oldSession(registry, old, after) : null;
  };
  gate.stopWire = JSON.stringify({ v: 1, path: db.filename, intent, old, pins });
  return gate;
}

/** ACP /clear：新线程先完成引导（运行时要的话，host-runtime.ts），再原子换 registry；失败时由宿主接回旧线程。 */
import { CLEAR_BUDGET_VERSION, type ClearBudget } from "./clear-budget.js";
import { RpcError, RpcLostError } from "./rpc.js";
import type { AcpSession } from "./session.js";
import { isValidOpId, type AcpTurnLoop } from "./turn.js";

type ClearResult = { ok: true; sessionId: string } | { ok: false; error: string; changed: boolean };

/** session/new 上限 90s；共享预算还覆盖两次配置、引导、registry 和 watcher（clear-budget.ts） */
const CREATE_TIMEOUT_MS = 90_000;

async function createClearedSession(
  session: AcpSession, oldSessionId: string, cwd: string,
  rotateRegistry: (oldId: string, newId: string, timeoutMs?: number) => Promise<{ ok: boolean; error?: string }>,
  configure: (session: AcpSession, budget?: ClearBudget) => Promise<void>,
  bootstrap: string | undefined, budget?: ClearBudget,
): Promise<ClearResult> {
  try {
    const fresh = await session.create(cwd, budget?.timeout(CREATE_TIMEOUT_MS) ?? CREATE_TIMEOUT_MS);
    if (fresh === oldSessionId) throw new Error("session/new 没生成新的线程 id");
    await configure(session, budget);
    const outcome = bootstrap ? await session.prompt(bootstrap, budget?.timeout(60_000) ?? 60_000) : { kind: "done" as const };
    if (outcome.kind !== "done") throw new Error(`新线程引导未完成：${outcome.kind === "failed" ? outcome.failure.message : "已取消"}`);
    const committed = await rotateRegistry(oldSessionId, fresh, budget?.timeout(30_000));
    if (!committed.ok) throw new Error(`registry 未换代：${committed.error ?? "未知原因"}`);
    return { ok: true, sessionId: fresh };
  } catch (error) {
    // Pi 适配器先停旧会话再起新的：新的起不来时它在错误里标 previousSessionClosed，适配器手上已没有旧会话，要按「变了」重起接回
    // 发出后没等到回包（超时 / 断线）：对端可能已换了线程（Pi 适配器会先停旧的），按「变了」重起接回，否则宿主拿旧 id 发的每一轮都被拒
    const closedOld = error instanceof RpcError && (error.data as { previousSessionClosed?: unknown } | undefined)?.previousSessionClosed === true;
    const unknown = error instanceof RpcLostError && error.sent;
    return { ok: false, error: error instanceof Error ? error.message : String(error), changed: closedOld || unknown || session.sessionId !== oldSessionId };
  }
}

/** bridge 帧里的 then（acp-link acpClear）：形状不对就当没带，clear 照旧（不因此拒掉换会话） */
export function clearThen(v: unknown): { text: string; opId: string } | undefined {
  const t = v as { text?: unknown; opId?: unknown } | null | undefined;
  return t && typeof t.text === "string" && t.text.trim() && isValidOpId(t.opId) ? { text: t.text, opId: t.opId } : undefined;
}

/** 宿主的轮换闸：只有空闲才能进；挂起期间入站留在 turn 队列，失败按旧 id 接回。 */
export async function rotateAcpHost(o: {
  session: AcpSession | null; ready: boolean; pending: boolean; loop: AcpTurnLoop;
  oldId: string; cwd: string; bootstrap?: string; budget?: ClearBudget;
  /** 换代成功后新会话的第一轮（save-clear 回读交接）：在恢复入站之前排到队首，轮换期间到的入站排它后面；失败 / 不明时不提交 */
  then?: { text: string; opId: string };
  rotateRegistry: (oldId: string, newId: string, timeoutMs?: number) => Promise<{ ok: boolean; error?: string }>;
  configure: (session: AcpSession, budget?: ClearBudget) => Promise<void>;
  begin(): void;
  failed(changed: boolean): void;
  committed(newId: string, session: AcpSession): Promise<void>;
  end(): void;
}): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  if (!o.session || !o.ready) return { ok: false, error: "ACP 宿主尚未就绪" };
  if (o.pending) return { ok: false, error: "还有未送达的输出或权限请求，请稍后重试" };
  if (!o.loop.suspendIfIdle()) return { ok: false, error: "当前回合还在进行，请稍后重试" };
  o.begin();
  let waitingForRebind = false;
  try {
    const result = await createClearedSession(o.session, o.oldId, o.cwd, o.rotateRegistry, o.configure, o.bootstrap, o.budget);
    if (!result.ok) return o.failed(result.changed), { ok: false, error: result.error };
    try {
      await o.committed(result.sessionId, o.session);
      o.budget?.timeout(1);
    } catch (e) {
      waitingForRebind = !o.budget;
      if (o.budget) o.failed(true);
      return { ok: false, sessionId: result.sessionId,
        error: `新线程已写入 registry，但 watcher 尚未就绪（${o.budget ? "结果未确认" : "后台重试中"}）：${e instanceof Error ? e.message : e}` };
    }
    if (o.then) o.loop.submitOp(o.then.text, o.then.opId, true);
    return { ok: true, sessionId: result.sessionId };
  } finally {
    o.end();
    if (!waitingForRebind) o.loop.resume();
  }
}

/** watcher 暂时不在时后台重试；条目带 sessionId，旧 watcher 会拒收，不会误确认。 */
function retryAcpRebind(request: () => Promise<boolean>, ready: () => void, alive: () => boolean): void {
  const retry = async () => {
    if (!alive()) return;
    const ok = await request().catch((e) => (console.warn(`⚠️ ACP watcher 重绑重试失败：${e}`), false));
    if (ok) ready();
    else setTimeout(() => void retry(), 3_000);
  };
  setTimeout(() => void retry(), 3_000);
}

export async function commitAcpClear(o: {
  budget?: ClearBudget;
  sessionId: string; previousSessionId: string; channelId: string; update(): void; ready(): void; alive(): boolean;
  request(frame: Record<string, unknown>, timeoutMs: number): Promise<boolean>;
}): Promise<void> {
  o.update();
  const bind = () => o.request({ type: "acp_rebind", channelId: o.channelId, sessionId: o.sessionId, previousSessionId: o.previousSessionId,
    ...(o.budget ? { clearBudgetVersion: CLEAR_BUDGET_VERSION, deadline: o.budget.deadline } : {}) }, o.budget?.timeout(30_000) ?? 30_000);
  if (!(await bind().catch((e) => (console.warn(`⚠️ ACP watcher 重绑失败：${e}`), false)))) {
    if (!o.budget) retryAcpRebind(bind, o.ready, o.alive);
    throw new Error("bridge 未确认新 watcher");
  }
  o.budget?.timeout(1);
  o.ready();
}

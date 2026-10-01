/** ACP /clear：新线程先完成引导（运行时要的话，host-runtime.ts），再原子换 registry；失败时由宿主接回旧线程。 */
import type { AcpSession } from "./session.js";
import type { AcpTurnLoop } from "./turn.js";

type ClearResult = { ok: true; sessionId: string } | { ok: false; error: string; changed: boolean };

async function createClearedSession(
  session: AcpSession, oldSessionId: string, cwd: string,
  rotateRegistry: (oldId: string, newId: string) => Promise<{ ok: boolean; error?: string }>,
  configure: (session: AcpSession) => Promise<void>,
  bootstrap: string | undefined,
): Promise<ClearResult> {
  try {
    const fresh = await session.create(cwd, 50_000);
    if (fresh === oldSessionId) throw new Error("session/new 没生成新的线程 id");
    await configure(session);
    const outcome = bootstrap ? await session.prompt(bootstrap, 60_000) : { kind: "done" as const };
    if (outcome.kind !== "done") throw new Error(`新线程引导未完成：${outcome.kind === "failed" ? outcome.failure.message : "已取消"}`);
    const committed = await rotateRegistry(oldSessionId, fresh);
    if (!committed.ok) throw new Error(`registry 未换代：${committed.error ?? "未知原因"}`);
    return { ok: true, sessionId: fresh };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), changed: session.sessionId !== oldSessionId };
  }
}

/** 宿主的轮换闸：只有空闲才能进；挂起期间入站留在 turn 队列，失败按旧 id 接回。 */
export async function rotateAcpHost(o: {
  session: AcpSession | null; ready: boolean; pending: boolean; loop: AcpTurnLoop;
  oldId: string; cwd: string; bootstrap?: string;
  rotateRegistry: (oldId: string, newId: string) => Promise<{ ok: boolean; error?: string }>;
  configure: (session: AcpSession) => Promise<void>;
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
    const result = await createClearedSession(o.session, o.oldId, o.cwd, o.rotateRegistry, o.configure, o.bootstrap);
    if (!result.ok) return o.failed(result.changed), { ok: false, error: result.error };
    try {
      await o.committed(result.sessionId, o.session);
    } catch (e) {
      waitingForRebind = true;
      return { ok: false, sessionId: result.sessionId, error: `新线程已写入 registry，但 watcher 尚未就绪（后台重试中）：${e instanceof Error ? e.message : e}` };
    }
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
  sessionId: string; previousSessionId: string; channelId: string; update(): void; ready(): void; alive(): boolean;
  request(frame: Record<string, unknown>, timeoutMs: number): Promise<boolean>;
}): Promise<void> {
  o.update();
  const bind = () => o.request({ type: "acp_rebind", channelId: o.channelId, sessionId: o.sessionId, previousSessionId: o.previousSessionId }, 30_000);
  if (!(await bind().catch((e) => (console.warn(`⚠️ ACP watcher 重绑失败：${e}`), false)))) {
    retryAcpRebind(bind, o.ready, o.alive);
    throw new Error("bridge 未确认新 watcher");
  }
  o.ready();
}

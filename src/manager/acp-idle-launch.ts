/** 空闲迁移专用启动：旧 TUI 已自愿退出，整个路径没有 gracefulExit / interrupt / kill。 */
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { listWindowIdsByName, tmuxRawStrict, sessionTarget, MASTER_SESSION } from "../lib/tmux-helper.js";
import { managedFor } from "../lib/runtimes/index.js";
import { tmuxWindowOps } from "../lib/runtimes/window-ops.js";
import { checkAcpReady } from "../lib/acp/readiness.js";
import { loadRegistry, saveRegistry } from "./core.js";
import { tryLockRestart, unlockRestart } from "./restart-lock.js";
import { requireExitedCodex } from "./acp-idle-restart.js";

export async function launchIdleAcp(name: string) {
  const lock = await acquireLock(statePath(".manager-write.lock"));
  if (!lock) return { ok: false, error: "迁移写锁未拿到" };
  let claimed = false;
  try {
    claimed = tryLockRestart(name);
    if (!claimed) return { ok: false, error: "另一个 restart 在跑" };
    const reg = await loadRegistry(), info = reg.agents[name];
    const ids = await listWindowIdsByName(name, true);
    await requireExitedCodex(info as any, ids);
    if (!(await checkAcpReady(true)).ok) return { ok: false, error: "旧窗口不在或 ACP 尚未就绪，保留待重启标记" };
    const adapter = managedFor("codex", "acp")!;
    const win = ids[0] ? tmuxWindowOps(name, ids[0]) : { ...tmuxWindowOps(name), setOption: async () => true };
    await adapter.beforeLaunch?.(win);
    await requireExitedCodex((await loadRegistry()).agents[name] as any, await listWindowIdsByName(name, true));
    const spec = (await import("./restart-spec.js")).restartSpec(name, info);
    const command = adapter.buildLaunchCommand({ ...spec, settingsName: name });
    const parked = ids[0] ? `parked-t60-${name}-${Date.now()}` : undefined;
    // 不往旧 shell 打启动命令：它随时可能被 owner 接管。保留旧窗、在新窗直接 exec 宿主，没有发键竞态。
    if (parked) await tmuxRawStrict(["rename-window", "-t", ids[0]!, parked]);
    let newId: string;
    try {
      newId = (await tmuxRawStrict(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionTarget(MASTER_SESSION),
        "-n", name, "-c", info.cwd || process.env.HOME || "/", command])).trim();
    } catch (e) {
      if (parked) await tmuxRawStrict(["rename-window", "-t", ids[0]!, name]);
      throw e;
    }
    const result = await adapter.waitReady(tmuxWindowOps(name, newId), { rounds: 120, pollMs: 500 });
    if (!result.ready) return { ok: false, error: result.reason };
    const fresh = await loadRegistry(), state = fresh.agents[name] as typeof info & { transport?: string; acpRestartPending?: boolean; acpRestartFrom?: string };
    if (state?.sessionId === info.sessionId && state.transport === "acp") {
      delete state.acpRestartPending;
      delete state.acpRestartFrom;
      await saveRegistry(fresh);
    }
    return { ok: true, agent: name, parkedWindow: parked };
  } catch (e) { return { ok: false, error: String(e) }; }
  finally { if (claimed) unlockRestart(name); lock.release(); }
}

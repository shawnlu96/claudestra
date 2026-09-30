/** 启动后重试待迁移项：只有旧 Codex 自愿退出到 shell 后才改 transport 并启动 ACP。 */
import { checkAcpReady } from "../lib/acp/readiness.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { listWindowIdsByName, windowChildPids } from "../lib/tmux-helper.js";
import { exitIdleCodex } from "../lib/runtimes/codex-idle-exit.js";
import { tmuxWindowOps } from "../lib/runtimes/window-ops.js";
import { loadRegistry, saveRegistry } from "./core.js";
import { tryLockRestart, unlockRestart } from "./restart-lock.js";

type Agent = { runtime?: string; status?: string; transport?: string; acpPending?: boolean; acpRestartPending?: boolean; acpRestartFrom?: string; channelId?: string };
type Deps = {
  load: typeof loadRegistry; save: typeof saveRegistry;
  ready: () => Promise<{ ok: boolean }>; lock: () => ReturnType<typeof acquireLock>;
  hold: (channel: string) => Promise<string | null>; unhold: (channel: string, token: string) => Promise<void>;
  exit: (name: string) => Promise<boolean>; claim: (name: string) => boolean; release: (name: string) => void;
};
const defaults: Deps = {
  load: loadRegistry, save: saveRegistry, ready: () => checkAcpReady(true), lock: () => acquireLock(statePath(".manager-write.lock")),
  exit: async (name) => {
    const ids = await listWindowIdsByName(name, true);
    return ids.length === 1 && exitIdleCodex({ ...tmuxWindowOps(name, ids[0]!), childPids: () => windowChildPids(ids[0]!, true) });
  },
  hold: async (channelId) => {
    const r = await bridgeRequest({ type: "acp_migration_hold", channelId });
    return r?.ok && typeof r.token === "string" ? r.token : null;
  },
  unhold: async (channelId, token) => { await bridgeRequest({ type: "acp_migration_hold", channelId, token, release: true }); },
  claim: tryLockRestart, release: unlockRestart,
};
export async function migrateIdleCodex(run: (name: string) => Promise<any>, deps: Deps = defaults) {
  const names = Object.entries((await deps.load()).agents).filter(([, a]) => eligible(a)).map(([name]) => name);
  const migrated: string[] = [], pending: string[] = [], failed: string[] = [];
  if (!names.length || !(await deps.ready()).ok) return { migrated, pending: names, failed };
  for (const name of names) {
    const lock = await deps.lock();
    if (!lock) { pending.push(name); continue; }
    let stopped = false, token: string | null = null, channel = "";
    try {
      const reg = await deps.load();
      if (!eligible(reg.agents[name]) || !deps.claim(name)) { pending.push(name); continue; }
      try {
        channel = (reg.agents[name] as Agent).channelId ?? "";
        token = channel ? await deps.hold(channel) : null;
        if (!token) { pending.push(name); continue; }
        if ((reg.agents[name] as Agent).transport === "tmux" && !(await deps.exit(name))) { pending.push(name); continue; }
        const state = reg.agents[name] as Agent;
        state.transport = "acp";
        delete state.acpPending;
        state.acpRestartPending = true;
        state.acpRestartFrom = "tmux";
        await deps.save(reg);
        stopped = true;
      } finally { deps.release(name); }
    } catch (e) { console.error(`[migrate-idle] ${name}: ${String(e)}`); failed.push(name); }
    finally {
      lock.release();
      if (!stopped && token) {
        await deps.unhold(channel, token).catch((e) => console.warn(`[migrate-idle] 消息闸释放失败，租约到期重试：${String(e)}`));
        token = null;
      }
    }
    try {
      if (!stopped) continue;
      const r = await run(name);
      if (r?.ok === false || r?.results?.some((x: { ok?: boolean }) => x.ok === false)) failed.push(name);
      else migrated.push(name);
    } catch (e) { console.error(`[migrate-idle] ${name} 启动失败：${String(e)}`); failed.push(name); }
    finally {
      if (token) await deps.unhold(channel, token).catch((e) => console.warn(`[migrate-idle] ${name} 消息闸释放失败，租约到期重试：${String(e)}`));
    }
  }
  return { migrated, pending, failed };
}
function eligible(a: Agent | undefined): boolean {
  return a?.runtime === "codex" && a.status === "active" && ((a.transport === "tmux" && a.acpPending === true)
    || (a.transport === "acp" && a.acpRestartPending === true && a.acpRestartFrom === "tmux"));
}

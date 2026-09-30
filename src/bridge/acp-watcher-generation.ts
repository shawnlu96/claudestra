/** ACP clear 的显式 watcher 换代胜过较早发出的异步登记查询。 */
import { readRegistryAgents } from "../lib/registry.js";

type Binding = { sessionId: string };
const bound = new Map<string, Binding>();

async function registrySession(channelId: string): Promise<string | null> {
  return (await readRegistryAgents()).find((a) => a.channelId === channelId)?.sessionId ?? null;
}

/** install 同步执行：校验代际与真正换 watcher 之间不能再让出事件循环。 */
export async function installAcpPushWatcher(
  channelId: string, sessionId: string, rebind: boolean, install: () => void,
  currentSession: (channelId: string) => Promise<string | null> = registrySession,
): Promise<boolean> {
  const before = bound.get(channelId);
  if (!rebind && before && before.sessionId !== sessionId) {
    let current: string | null;
    try { current = await currentSession(channelId); }
    catch (e) { console.warn(`⚠️ ACP watcher 代际核对失败：${e}`); return false; }
    if (bound.get(channelId) !== before || current !== sessionId) return false;
  }
  if (rebind || before?.sessionId !== sessionId) bound.set(channelId, { sessionId });
  try { install(); }
  catch (e) {
    if (before) bound.set(channelId, before);
    else bound.delete(channelId);
    throw e;
  }
  return true;
}

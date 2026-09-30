/** ACP 忙闲由宿主回合循环给出；离线或超时按忙处理，绝不当成安全重启依据。 */
import { bridgeRequest } from "../lib/bridge-client.js";
import { controlFor, normalizeTransport } from "../lib/runtimes/index.js";
import type { loadRegistry } from "./core.js";
export async function agentIdle(name: string, load: typeof loadRegistry, paneIdle: () => Promise<boolean>, request = bridgeRequest): Promise<boolean> {
  const bare = name.replace(/^agent-/, "");
  const reg = await load();
  const info = reg.agents?.[name] ?? reg.agents?.[bare] ?? reg.agents?.[`agent-${bare}`];
  const source = controlFor(info?.runtime, normalizeTransport((info as { transport?: string } | undefined)?.transport)).idleSource;
  if (source === "pane") return paneIdle();
  if (source !== "acp") return true; // Pi/旧 Codex 保持现有 hook 行为，不套 CC 画面判据。
  if (!info?.channelId) return false;
  try {
    const r = await request({ type: "acp_status", channelId: info.channelId }, { timeoutMs: 4_000 });
    return r?.ok === true && r.busy === false && r.sessionId === info.sessionId;
  } catch (e) { console.warn(`[idle] ${name} 宿主状态未确认，按忙处理：${String(e)}`); return false; }
}

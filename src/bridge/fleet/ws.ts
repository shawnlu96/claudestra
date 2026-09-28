/**
 * CLI（manager fleet）走的 ws 请求：`fleet_state` / `fleet_run`。
 * 信任级别与 route_to_agent 相同：ws 升级那一层已经拒掉非回环连接（没 BRIDGE_CONTROL_TOKEN 一律拒），
 * 这里再按连接地址判一次回环兜底。本机能连上 ws 的进程本来就能直接敲 tmux，不扩大权限。
 */
import { parseFleetAction, parseFleetSelect } from "../../lib/fleet-plan.js";
import { fleetState, runFleet } from "./service.js";

/** 返回 bridgeRequest 认的形状：{ result } 或 { error } */
/** wsData = 升级时 bridge.ts 塞进 ws.data 的 { loopback }（直连回环且不带 X-Forwarded-For 才是 true） */
export async function handleFleetWs(msg: Record<string, unknown>, wsData: unknown): Promise<{ result?: unknown; error?: string }> {
  if ((wsData as { loopback?: unknown } | undefined)?.loopback !== true) return { error: "批量管理只收本机直连回环的连接" };
  try {
    if (msg.type === "fleet_state") return { result: await fleetState() };
    const a = parseFleetAction(msg.action);
    if (!a.ok) return { error: a.error };
    const s = parseFleetSelect(msg.select);
    if (!s.ok) return { error: s.error };
    return { result: await runFleet({ action: a.action, select: s.select, dryRun: msg.dryRun === true, actor: "owner", via: "cli" }) };
  } catch (e) {
    return { error: `批量管理出错：${(e as Error).message}` };
  }
}

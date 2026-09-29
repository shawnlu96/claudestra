/**
 * CLI（manager fleet）走的 ws 请求：`fleet_state` / `fleet_run`。
 * 信任级别与 route_to_agent 相同：ws 升级那一层已经拒掉非回环连接（没 BRIDGE_CONTROL_TOKEN 一律拒），
 * 这里再按连接地址判一次回环兜底。本机任何进程（包括被注入的 agent 跑的 Bash）都能连 ws，认不出是不是 owner，
 * 所以落款记 local-cli、不写 owner；群发文字、自定义保留清单、带上大总管只给网页的 owner 路径（T35 adv1 P1-1），状态里也不列大总管。
 */
import { parseFleetAction, parseFleetSelect } from "../../lib/fleet-plan.js";
import { isMasterName } from "../../lib/registry.js";
import { fleetState, runFleet, type FleetAllowed } from "./service.js";

const LOCAL_CLI: FleetAllowed = (name) => !isMasterName(name);

/**
 * 返回 bridgeRequest 认的形状：{ result } 或 { error }。wsData = 升级时 bridge.ts 塞进 ws.data 的 { loopback }
 * （直连回环且不带 X-Forwarded-For 才是 true）；run 只给单测换成假的，看落款
 */
export async function handleFleetWs(msg: Record<string, unknown>, wsData: unknown, run = runFleet): Promise<{ result?: unknown; error?: string }> {
  if ((wsData as { loopback?: unknown } | undefined)?.loopback !== true) return { error: "批量管理只收本机直连回环的连接" };
  try {
    if (msg.type === "fleet_state") return { result: await fleetState(LOCAL_CLI) };
    const a = parseFleetAction(msg.action);
    if (!a.ok) return { error: a.error };
    const s = parseFleetSelect(msg.select);
    if (!s.ok) return { error: s.error };
    const keep = (msg.action as { keep?: unknown } | null)?.keep;
    if (a.action.kind === "text" || keep !== undefined || s.select.includeMaster || s.select.agents?.some(isMasterName)) {
      return { error: "命令行不能群发文字、自定义保留清单或带上大总管：这些只在网页上用 owner 设备操作" };
    }
    return { result: await run({ action: a.action, select: s.select, dryRun: msg.dryRun === true, actor: "local-cli", via: "ws", allowed: LOCAL_CLI }) };
  } catch (e) {
    return { error: `批量管理出错：${(e as Error).message}` };
  }
}

/**
/**
 * ws 请求 `fleet_state` / `fleet_run` 的入口，两类连接，都先要求升级时是直连回环（ws 升级那一层已拒非回环，这里按连接地址再判一次兜底）：
 * - channel-server 的 `fleet` MCP 工具（带 via:"mcp"）：按这条连接上注册的频道认调用方（lib/fleet-caller.ts），
 *   不信请求里的任何身份字段；只有大总管、台账 pms、config fleet.callers 放行，并按调用方收窄范围。
 * - 其余（manager CLI、本机任何进程包括 agent 跑的 Bash）：认不出是不是 owner，落款记 local-cli、不写 owner。
 * 两类都不收自定义保留清单、不动大总管（只给网页的 owner 路径）；群发文字只开给认出身份的 MCP 调用方，走 notification。
 */
import { readConfigSync } from "../../lib/config-store.js";
import { FleetScopeError, identifyFleetCaller, MCP_TEXT_MAX, type CallerDecision } from "../../lib/fleet-caller.js";
import { bareName, parseFleetAction, parseFleetSelect } from "../../lib/fleet-plan.js";
import { openLedger, pmsByProject } from "../../lib/ledger-store.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { connectionOf, fleetState, runFleet } from "./service.js";

function readPms(): Map<string, string[]> {
  try {
    return pmsByProject(openLedger());
  } catch (e) {
    // 台账读不到就当没有 PM：只会让 PM 被拒（收紧），不会放进不该放的人
    console.warn(`⚠️ [fleet] 读台账 PM 名单失败，本次按没有 PM 判：${(e as Error).message}`);
    return new Map();
  }
}

async function whoIs(ws: unknown, mcp: boolean): Promise<CallerDecision> {
  const { channels, controlChannelId } = connectionOf(ws);
  const reg = channels.length === 1 ? (await readRegistryAgents()).find((r) => r.channelId === channels[0]) : undefined;
  const callers = readConfigSync().fleet?.callers ?? [];
  return identifyFleetCaller({
    channels, mcp, controlChannelId,
    agent: reg ? { name: reg.name, external: reg.external } : null,
    pmsByProject: channels.length && !channels.includes(controlChannelId ?? "") ? readPms() : new Map(),
    callers,
  });
}

/** 返回 bridgeRequest 认的形状：{ result } 或 { error }。ws = bridge.ts 里收到这条消息的连接（ws.data.loopback 升级时标好） */
export async function handleFleetWs(msg: Record<string, unknown>, ws: unknown): Promise<{ result?: unknown; error?: string }> {
  if ((ws as { data?: { loopback?: unknown } } | undefined)?.data?.loopback !== true) return { error: "批量管理只收本机直连回环的连接" };
  try {
    const who = await whoIs(ws, msg.via === "mcp");
    if (who.kind === "deny") {
      console.warn(`🛰 [fleet] 拒绝 ${String(msg.type)}（${connectionOf(ws).channels.join(",") || "未注册连接"}）：${who.error}`);
      return { error: who.error };
    }
    const caller = who.kind === "ok" ? who.caller : undefined;
    if (msg.type === "fleet_state") return { result: await fleetState(caller) };
    const a = parseFleetAction(msg.action);
    if (!a.ok) return { error: a.error };
    const s = parseFleetSelect(msg.select);
    if (!s.ok) return { error: s.error };
    const keep = (msg.action as { keep?: unknown } | null)?.keep;
    if (caller) {
      // 工具那侧已经挡过 keep 和字数，这里是真正的闸（请求可以不经工具直接发到这条连接上）。
      // text 已在 parseFleetAction 里中和过委托标记；大总管、越界、压自己由 runFleet 里的 scopeForCaller 拒
      if (keep !== undefined) return { error: "fleet 工具不接受 keep：压缩统一用 config 里的保留清单" };
      if ((a.action.text ?? "").length > MCP_TEXT_MAX) return { error: `text 不能超过 ${MCP_TEXT_MAX} 字` };
      // MCP 默认预演：只有明确的 false 才真执行
      return { result: await runFleet({ action: a.action, select: s.select, dryRun: msg.dryRun !== false, actor: caller.name, via: "mcp", caller }) };
    }
    if (a.action.kind === "text" || keep !== undefined || s.select.includeMaster || s.select.agents?.some((n) => bareName(n) === "master")) {
      return { error: "命令行不能群发文字、自定义保留清单或带上大总管：这些只在网页上用 owner 设备操作" };
    }
    return { result: await runFleet({ action: a.action, select: s.select, dryRun: msg.dryRun === true, actor: "local-cli", via: "ws" }) };
  } catch (e) {
    return { error: e instanceof FleetScopeError ? e.message : `批量管理出错：${(e as Error).message}` };
  }
}

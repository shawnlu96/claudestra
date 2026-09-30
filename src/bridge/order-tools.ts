/**
 * bridge 侧的派单工具（M2 执行者 / M3 审查员）：`order_tool {tool, args}` 帧 → 认身份（bridge/caller-identity.ts callerOf）→
 * lib/order-tool-route.ts 过 requireVerified 门 → 按工具名登记的 handler。加工具只在 HANDLERS 里加一项（channel-server 那边在
 * lib/order-tools.ts ORDER_TOOLS 加定义），bridge.ts 与 ACP 回环代理都不用动。写台账一律经 lib/order-ledger-exit.ts（runManager）。
 */
import type { ServerWebSocket } from "bun";
import type { LedgerRun } from "../lib/order-ledger-exit.js";
import { refuse, routeOrderTool, type OrderToolHandler, type OrderToolResult } from "../lib/order-tool-route.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { callerOf } from "./caller-identity.js";
import { reviewToolHandlers } from "./review-tools.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";

/** manager 以调用方频道为身份跑：actor 由 CLI 按 DISCORD_CHANNEL_ID 算（manager/ledger-identity.ts）。handler 经 lib/order-ledger-exit.ts ledgerWrite 用它 */
const ledgerRun: LedgerRun = (args, channelId) =>
  runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: channelId }, timeoutMs: 30_000 });

const pending: OrderToolHandler = async () => refuse("not_implemented", "这个工具还没接上");

const HANDLERS: Record<string, OrderToolHandler> = {
  take_order: pending,
  deliver: pending,
  ask: pending,
  ...reviewToolHandlers(ledgerRun),
};

export async function answerOrderTool(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>): Promise<void> {
  const { identity, channelId } = callerOf(ws, msg);
  let result: OrderToolResult;
  try {
    result = await routeOrderTool(msg.tool, identity, channelId, msg.args, HANDLERS);
  } catch (e) {
    console.error(`⚠ 派单工具 ${String(msg.tool)}（${identity.agent ?? "?"}）出错：${(e as Error).message}`);
    result = refuse("internal", `bridge 处理出错：${(e as Error).message}`);
  }
  try {
    ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
  } catch (e) {
    console.error(`⚠ 派单工具回包失败（调用方已断开？重试会按 dedup 回放）：${(e as Error).message}`);
  }
}

/**
 * bridge 侧的派单工具（M2 执行者 / M3 审查员）：`order_tool {tool, args}` 帧 → 认身份（bridge/caller-identity.ts callerOf）→
 * lib/order-tool-route.ts 过 requireVerified 门 → 按工具名登记的 handler。加工具只在 HANDLERS 里加一项（channel-server 那边在
 * lib/order-tools.ts ORDER_TOOLS 加定义），bridge.ts 与 ACP 回环代理都不用动。写台账一律经 lib/order-ledger-exit.ts（runManager）。
 */
import type { ServerWebSocket } from "bun";
import { openAskFull } from "../lib/ledger-asks.js";
import { askOrder } from "../lib/order-ask.js";
import { deliverOrder, remoteBranchHead } from "../lib/order-deliver.js";
import type { LedgerRun } from "../lib/order-ledger-exit.js";
import { currentOrders, orderWireFor } from "../lib/order-take.js";
import { refuse, routeOrderTool, type OrderToolHandler, type OrderToolResult } from "../lib/order-tool-route.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runBounded } from "../lib/run-bounded.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { askDb } from "./asks.js";
import { callerOf } from "./caller-identity.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH, MASTER_DIR } from "./config.js";
import { ledgerDb } from "./ledger-feed.js";
import { sendLedgerNotice } from "./team-router.js";

/** manager 以调用方频道为身份跑：actor 由 CLI 按 DISCORD_CHANNEL_ID 算（manager/ledger-identity.ts）。handler 经 lib/order-ledger-exit.ts ledgerWrite 用它 */
const ledgerRun: LedgerRun = (args, channelId) =>
  runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: channelId }, timeoutMs: 30_000 });

/** 调用方的工作目录（查 origin 用）：只按身份里的 agent 取 registry，大总管取 MASTER_DIR */
const cwdOf = (agent: string): string | undefined => (agent === "master" ? MASTER_DIR : readRegistryAgentsSync().find((a) => a.name === agent)?.cwd);

/** 当前的单：多张时取最近动过的一张，其余的单号一并告诉它（deliver / ask 认其中任何一张） */
const takeOrder: OrderToolHandler = async (call) => {
  const db = ledgerDb();
  const cur = db ? currentOrders(db, call) : [];
  if (!db || !cur.length) return { ok: true, order: null };
  const w = orderWireFor(db, cur[0]);
  if (!w.ok) return refuse("invalid_order", w.error);
  return { ok: true, order: w.order, ...(cur.length > 1 ? { otherOrderIds: cur.slice(1).map((o) => o.orderId) } : {}) };
};

const HANDLERS: Record<string, OrderToolHandler> = {
  take_order: takeOrder,
  deliver: (call, args) => deliverOrder(call, args, { db: ledgerDb(), run: ledgerRun, remoteHead: (c, branch) => remoteBranchHead(cwdOf(c.agent), branch, runBounded) }),
  ask: (call, args) => askOrder(call, args, {
    db: ledgerDb(), open: (input) => openAskFull(askDb(), input), notify: (to, text, messageId) => sendLedgerNotice({ to, text, messageId }),
  }),
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

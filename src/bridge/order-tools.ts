/**
 * bridge 侧的派单工具（M2 执行者 / M3 审查员）：`order_tool {tool, args}` 帧 → 认身份（bridge/caller-identity.ts callerOf）→
 * lib/order-tool-route.ts 过 requireVerified 门 → 按工具名登记的 handler。加工具只在 HANDLERS 里加一项（channel-server 那边在
 * lib/order-tools.ts ORDER_TOOLS 加定义），bridge.ts 与 ACP 回环代理都不用动。写台账一律经 lib/order-ledger-exit.ts（runManager）。
 * 出借 worker（agent-lend-*）在 HANDLERS 之前整条分走（bridge/lend-tools.ts）：本机的台账 / 审查 / DAG 工具它一个都到不了。
 */
import type { ServerWebSocket } from "bun";
import { openAskFull, patchAsk } from "../lib/ledger-asks.js";
import { appendEvent } from "../lib/ledger-write.js";
import { isLendCaller } from "../lib/lend-tools.js";
import { askOrder } from "../lib/order-ask.js";
import { deliverOrder, remoteBranchHead } from "../lib/order-deliver.js";
import { findPrRows } from "../lib/order-deliver-pr.js";
import type { LedgerRun } from "../lib/order-ledger-exit.js";
import { markingTakes, recordTaken } from "../lib/order-mark.js";
import { takeOrderWithMemory } from "../lib/memory-retrieve-take.js";
import { refuse, routeOrderTool, type OrderToolHandler, type OrderToolResult, type VerifiedCall } from "../lib/order-tool-route.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runBounded } from "../lib/run-bounded.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { askDb } from "./asks.js";
import { callerOf } from "./caller-identity.js";
import { dagToolHandlers } from "./dag-tools.js";
import { memoryToolHandlers } from "../lib/memory-tools.js";
import { answerLendTool } from "./lend-tools.js";
export { lendFrameDenied } from "./lend-tools.js"; // bridge.ts 原生帧入口的出借闸口，跟派单工具同一行 import 进去
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH, MASTER_DIR } from "./config.js";
import { ledgerDb } from "./ledger-feed.js";
import { reviewToolHandlers } from "./review-tools.js";
import { sendLedgerNotice } from "./team-router.js";

/** manager 以调用方频道为身份跑：actor 由 CLI 按 DISCORD_CHANNEL_ID 算（manager/ledger-identity.ts）。handler 经 lib/order-ledger-exit.ts ledgerWrite 用它 */
const ledgerRun: LedgerRun = (args, channelId) =>
  runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: channelId }, timeoutMs: 30_000 });

/** 调用方的工作目录（查 origin 用）：只按身份里的 agent 取 registry，大总管取 MASTER_DIR */
const cwdOf = (agent: string): string | undefined => (agent === "master" ? MASTER_DIR : readRegistryAgentsSync().find((a) => a.name === agent)?.cwd);

/** 当前的单：多张时取最近动过的一张，其余的单号一并告诉它（deliver / ask 认其中任何一张） */
/** 写单借给了 peer 的卡：不发给本机会话，order 为空并带 note 说明（lib/order-take.ts takeOrderResult，i28-RS1） */
const takeOrder: OrderToolHandler = async (call) => {
  const r = await takeOrderWithMemory(ledgerDb(), call);
  return r.ok ? r : refuse("invalid_order", r.error);
};

const reviewHandlers = reviewToolHandlers(ledgerRun);
const markTaken = (call: VerifiedCall, ids: string[]) => recordTaken(ledgerDb(), call, ids, ledgerRun);
const orderIdOf = (o: unknown): string[] => (o && typeof o === "object" && typeof (o as { orderId?: unknown }).orderId === "string" ? [(o as { orderId: string }).orderId] : []);

const HANDLERS: Record<string, OrderToolHandler> = {
  ...reviewHandlers,
  // 领到调度器的单就留痕（lib/order-mark.ts）：调度器据此判「唤醒发出后有没有人领」，对账也认它
  take_order: markingTakes(takeOrder, (r) => orderIdOf(r.order), markTaken),
  take_review: markingTakes(reviewHandlers.take_review, (r) => (Array.isArray(r.orders) ? r.orders.flatMap(orderIdOf) : []), markTaken),
  deliver: (call, args) => deliverOrder(call, args, {
    db: ledgerDb(), run: ledgerRun, remoteHead: (c, branch) => remoteBranchHead(cwdOf(c.agent), branch, runBounded),
    findPr: (c, branch) => findPrRows(cwdOf(c.agent), branch, runBounded),
  }),
  ask: (call, args) => askOrder(call, args, {
    db: ledgerDb(), open: (input) => openAskFull(askDb(), input), notify: (to, text, messageId) => sendLedgerNotice({ to, text, messageId }),
    // handedAt：默认做法提问的 15 分钟从这里算（order-ask-default.ts）
    markHanded: (id) => patchAsk(askDb(), id, { extra: { notice: "handed", handedAt: Date.now() } }), record: (ctx, input) => void appendEvent(askDb(), ctx, input),
  }),
  ...dagToolHandlers(),
  ...memoryToolHandlers(ledgerRun, ledgerDb), // 项目记忆 record / mark / show_memory（写经 manager，show 读只读连接）
};

export async function answerOrderTool(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>): Promise<void> {
  const { identity, channelId } = callerOf(ws, msg);
  let result: OrderToolResult;
  try {
    result = isLendCaller(identity) ? await answerLendTool(msg.tool, identity, msg.args) : await routeOrderTool(msg.tool, identity, channelId, msg.args, HANDLERS);
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

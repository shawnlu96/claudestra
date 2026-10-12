/**
 * B 侧 bridge 上出借 worker 的派单工具（i28-W4）：bridge/order-tools.ts 见到 agent-lend-* 身份就交到这里，逻辑在 lib/lend-tools.ts。
 * 这里只接真实依赖：本机出借 journal（没在出借就不建库，按「没有单」拒），以及对 A 的出站——只走 E2E（lib/lend-tools.ts e2eLendCall：
 * peer 记录钉钥 + E2E、没有代理变量、应答必须是 E2E 回来的），传输用 relay-link 的 peerFetch e2eOnly，此刻不是 E2E peer 就抛错不发。
 */
import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import type { CallerIdentity } from "../lib/caller-identity.js";
import { LEND_JOURNAL_PATH, openLendJournal } from "../lib/lend-journal.js";
import { e2eLendCall, lendFrameGate, routeLendTool } from "../lib/lend-tools.js";
import type { OrderToolResult } from "../lib/order-tool-route.js";
import { readPeers } from "../lib/peers.js";
import { callerOf } from "./caller-identity.js";
import { peerFetch } from "./relay-link.js";
import { sharedLendTool } from "./shared-ledger-v2-lend-tools.js";

/** 单次出站上限：channel-server 等派单工具回包 60 秒（lib/order-tools.ts），留出读写 journal 的余量 */
const OUTBOUND_MS = 25_000;

const call = e2eLendCall({
  peers: async () => (await readPeers()).httpPeers ?? [],
  post: (url, init) => peerFetch(url, init, { timeoutMs: OUTBOUND_MS, e2eOnly: true }),
  env: process.env,
  timeoutMs: OUTBOUND_MS,
});

export async function answerLendTool(tool: unknown, identity: CallerIdentity, args: unknown): Promise<OrderToolResult> {
  const db = existsSync(LEND_JOURNAL_PATH) ? openLendJournal(LEND_JOURNAL_PATH) : null;
  try {
    const central = await sharedLendTool(tool, identity, args, db);
    if (central) return central;
    return await routeLendTool(tool, identity, args, { db, call, log: (m) => console.warn(`⚠️ [lend] ${m}`), now: () => Date.now() });
  } finally {
    db?.close();
  }
}

/** bridge.ts 原生帧入口的一行：出借 worker 的连接发频道 / 管理类帧 → 回 error 并返回 true（调用方 return，不进 switch） */
export function lendFrameDenied(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>): boolean {
  return lendFrameGate(msg, () => callerOf(ws).identity, (frame) => {
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      console.warn(`⚠️ [lend] 拒绝原生帧时回包失败（对方已断开？拒绝本身已生效）：${(e as Error).message}`);
    }
  }, (m) => console.warn(`⚠️ [lend] ${m}`));
}

/**
 * B 侧 bridge 上出借 worker 的派单工具（i28-W4）：bridge/order-tools.ts 见到 agent-lend-* 身份就交到这里，逻辑在 lib/lend-tools.ts。
 * 这里只接真实依赖：本机出借 journal（没在出借就不建库，按「没有单」拒），以及对 A 的出站——只走 E2E（lib/lend-tools.ts e2eLendCall：
 * peer 记录钉钥 + E2E、没有代理变量、应答必须是 E2E 回来的），传输用 relay-link 的 peerFetch e2eOnly，此刻不是 E2E peer 就抛错不发。
 */
import { existsSync } from "node:fs";
import type { CallerIdentity } from "../lib/caller-identity.js";
import { LEND_JOURNAL_PATH, openLendJournal } from "../lib/lend-journal.js";
import { e2eLendCall, routeLendTool } from "../lib/lend-tools.js";
import type { OrderToolResult } from "../lib/order-tool-route.js";
import { readPeers } from "../lib/peers.js";
import { peerFetch } from "./relay-link.js";

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
    return await routeLendTool(tool, identity, args, { db, call, log: (m) => console.warn(`⚠️ [lend] ${m}`), now: () => Date.now() });
  } finally {
    db?.close();
  }
}

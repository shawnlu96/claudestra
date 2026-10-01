/** manager 的运行时参数只取 journal 中已验过的家族；订单正文不能覆盖。 */
import type { Database } from "bun:sqlite";
import { getOrder } from "./lend-journal.js";
import { removeClaudeWorkerConfig } from "./lend-claude-worker.js";

export function lendRuntimeArgs(db: Database, order: string): string[] {
  const family = getOrder(db, order)?.family;
  if (family === "claude") return ["--runtime", "claude-code"];
  if (family === "codex") return ["--runtime", "codex", "--transport", "acp"];
  throw new Error("出借订单的家族缺失或不支持，不起 worker");
}

/** 创建失败（宿主尚未启动）也经 released 收尾删配置，不能只依靠宿主 finally。 */
export function removeClaudeOrderConfig(db: Database, order: string): void {
  const row = getOrder(db, order);
  if (row?.family === "claude" && row.agent) removeClaudeWorkerConfig(row.agent);
}

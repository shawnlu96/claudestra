/**
 * channel-server 与 bridge 之间「链路」的存活策略。
 *
 * 单独成文件是为了能被测试 import —— channel-server.ts 顶层有副作用
 * （缺 DISCORD_CHANNEL_ID 会直接 exit、main() 会去连 bridge），不能在测试里加载。
 *
 * 核心约束（决定了下面每一个判断）：**channel-server 没有守护者**。它是 Claude Code
 * 的 stdio 子进程，实测 Claude Code 既不会在它死后 respawn、也不会自动重连。所以
 * 进程退出 = 该 agent 永久失联，只能人工 `/mcp` 或重启。任何「退出」的决定都必须
 * 按这个代价来衡量。
 */

export type ReplacedAction = "exit" | "reconnect";

export interface ReplacedDecision {
  action: ReplacedAction;
  /** reconnect 时的退避毫秒数 */
  delayMs: number;
  /** 写进日志的原因，便于事后对账 */
  reason: string;
}

export const REPLACED_BASE_DELAY_MS = 3_000;
export const REPLACED_MAX_DELAY_MS = 60_000;

/**
 * 被 bridge 顶替（收到 replaced / close 4001）之后该怎么办。
 *
 * 旧行为是无条件 `process.exit(0)`，理由是「Claude Code 重启了 MCP server，新的
 * 才是正主」。但那个理由只在**我们的 stdio 已经被关掉**时成立。2026-07-25 实测到
 * 反例：在 agent 自己的 Bash 里误跑一次 `channel-server.ts`（DISCORD_CHANNEL_ID 由
 * Claude Code 注入、被所有子进程继承）就会顶掉正在服务的连接；那个进程 60 秒后被
 * 杀，频道空着没人接管，而正主早已自杀 —— agent 永久掉线。
 *
 * 所以判据改成 stdio：还连着就说明 Claude Code 仍在用本进程，我们才是正主，退避后
 * 回去把频道拿回来。**没有次数上限**：既然退出等于永久失联，那么「一直抢不回来」的
 * 正确应对是继续以最长 60s 的间隔重试（日志里看得见），而不是放弃。曾经写过 5 次
 * 上限，但那会在「两个都握过手的实例互抢」时让双方先后退出，把可恢复的抖动变成
 * 彻底失联 —— 比抢占本身更糟。
 */
export function decideAfterReplaced(opts: {
  mcpClosed: boolean;
  consecutiveReplaced: number;
}): ReplacedDecision {
  if (opts.mcpClosed) {
    return { action: "exit", delayMs: 0, reason: "MCP stdio 已关闭，Claude Code 不再使用本进程" };
  }
  const n = Math.max(1, opts.consecutiveReplaced);
  const delayMs = Math.min(
    REPLACED_BASE_DELAY_MS * Math.pow(2, Math.min(n - 1, 5)),
    REPLACED_MAX_DELAY_MS,
  );
  return {
    action: "reconnect",
    delayMs,
    reason: `MCP stdio 仍连着，本进程才是 Claude Code 在用的实例（第 ${n} 次被顶替）`,
  };
}

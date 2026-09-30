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

/**
 * bridge 拒绝注册用的 close code（T85，bridge/caller-identity.ts）：频道由已验证身份的会话持有，本连接没有有效凭据。
 * 它不是「被顶替」——不回来抢、不退出（退出 = 失联，见文件头），走下面的普通退避；退避计数只在 registered 时清零，
 * 所以被拒的一方 3s → 6s → … → 60s 降频。tests/caller-reject.test.ts 用真进程钉住。
 */
export const REJECTED_CLOSE_CODE = 4002;

/** 普通断线（bridge 重启、被拒）的重连退避：3s, 6s, 12s, 24s, 48s, 60s 封顶。attempts 从 1 起 */
export function reconnectDelayMs(attempts: number): number {
  return Math.min(REPLACED_BASE_DELAY_MS * Math.pow(2, Math.min(Math.max(1, attempts) - 1, 5)), REPLACED_MAX_DELAY_MS);
}

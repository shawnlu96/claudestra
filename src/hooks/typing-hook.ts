#!/usr/bin/env bun
/**
 * Claude Code Hook — Typing Indicator Control
 *
 * 通过 Claude Code hooks 机制精确控制 Discord typing indicator。
 * 当 Claude Code 完成处理（Stop）或等待输入（Notification）时，
 * 通知 bridge 停止 typing indicator。
 *
 * 配置方法：在 ~/.claude/settings.json 中添加 hooks。
 * 环境变量：DISCORD_CHANNEL_ID（每个 Claude Code 实例自动设置）
 */

const BRIDGE_PORT = process.env.BRIDGE_PORT || "3847";

async function main() {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!channelId) process.exit(0); // 非 Discord 模式，静默退出

  let input: string;
  try {
    input = await Bun.stdin.text();
  } catch {
    process.exit(0);
  }

  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const event = data.hook_event_name;

  // Stop — Claude 完成回复（发完成通知）
  // StopFailure — Claude 异常退出（也发完成通知）
  // Notification — Claude 等待输入（只停 typing，不重发完成通知）
  if (event === "Stop" || event === "StopFailure" || event === "Notification") {
    try {
      await fetch(`http://localhost:${BRIDGE_PORT}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, event }), // 传递原事件名，不再硬编码 "stop"
      });
    } catch { /* bridge 可能未运行 */ }
  }
}

main().catch(() => process.exit(0));

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

  // v2.13.1+ subagent 过滤：Agent/Task 工具起的 subagent 继承了主会话的
  // DISCORD_CHANNEL_ID，它内部的 Stop/Notification 会照样打到主 agent 的频道，
  // 让 bridge 把主 agent 的回合误判成已结束、提前清 pending thread（症状：
  // "我还在干活，界面上却显示完成了"）。2026-07-25 实测：并发 5 个 subagent
  // 让主频道两分钟内收到 6 次 Stop，而主会话只结束了 1-2 个回合。
  // agent_id 是官方 hook 契约里专门用来区分 subagent 与主线程的字段。
  if (data.agent_id) process.exit(0);

  const event = data.hook_event_name;

  // Stop — Claude 完成回复（发完成通知）
  // StopFailure — Claude 异常退出（也发完成通知）
  // Notification — Claude 等待输入（只停 typing，不重发完成通知）
  if (event === "Stop" || event === "StopFailure" || event === "Notification") {
    try {
      // 必须带超时：try/catch 抓得住"连不上"，抓不住"连上了但不回"。bridge 一旦
      // 卡住（不是挂掉），每个 agent 的每次 Stop hook 都会在这里无限等待，而 hook
      // 是**阻塞 Claude Code 回合收尾**的 —— 等于所有 agent 一起被拖住。
      await fetch(`http://localhost:${BRIDGE_PORT}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, event }), // 传递原事件名，不再硬编码 "stop"
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* bridge 可能未运行 */ }
  }
}

main().catch(() => process.exit(0));

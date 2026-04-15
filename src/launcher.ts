/**
 * Master Session Launcher
 *
 * pm2 管理的守护进程，确保大总管的 tmux session 始终存活。
 * 如果 session 死了自动重启。
 */

import {
  tmuxRaw,
  masterSessionExists,
  ensureSocketDir,
  isIdle as tmuxIsIdle,
  tmuxCapture,
  tmuxSendLine,
  hasClaudePromptToConfirm,
  MASTER_SESSION as SESSION_NAME,
} from "./lib/tmux-helper.js";
import { buildClaudeCommand } from "./lib/claude-launch.js";

// 默认 master 目录：仓库根 / master。允许 env 覆盖以支持自定义部署。
const MASTER_DIR = process.env.MASTER_DIR || `${import.meta.dir}/../master`;
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const CHECK_INTERVAL_MS = 15_000; // 每 15 秒检查一次

if (!CONTROL_CHANNEL_ID) {
  console.error("❌ 请设置 CONTROL_CHANNEL_ID（Discord #control 频道 ID）");
  process.exit(1);
}

const MASTER_WINDOW = `${SESSION_NAME}:0`;

async function sessionExists(): Promise<boolean> {
  return masterSessionExists();
}

async function isIdle(): Promise<boolean> {
  return tmuxIsIdle(MASTER_WINDOW);
}

async function captureLast(lines = 10): Promise<string> {
  return tmuxCapture(MASTER_WINDOW, lines);
}

async function startMaster() {
  console.log("🚀 启动大总管 session...");

  // 确保 socket 目录存在
  await ensureSocketDir();

  // 创建 tmux session
  await tmuxRaw(["new-session", "-d", "-s", SESSION_NAME, "-c", MASTER_DIR]);
  await Bun.sleep(500);

  // 启动 Claude Code（用统一的命令构造器）
  const cmd = buildClaudeCommand({
    channelId: CONTROL_CHANNEL_ID,
    bridgeUrl: BRIDGE_URL,
  });
  await tmuxSendLine(MASTER_WINDOW, cmd);

  // 等待并自动确认各种提示（dev channel、trust、bypass、etc）
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(10);

    if (await isIdle()) {
      console.log("✅ 大总管已就绪");
      return true;
    }

    if (hasClaudePromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  console.log("⚠️ 大总管启动超时，但 session 可能仍在初始化");
  return await sessionExists();
}

// ============================================================
// 主循环
// ============================================================

async function main() {
  console.log(`📡 Launcher 启动`);
  console.log(`   session: ${SESSION_NAME}`);
  console.log(`   control channel: ${CONTROL_CHANNEL_ID}`);
  console.log(`   检查间隔: ${CHECK_INTERVAL_MS / 1000}s`);

  // 首次检查
  if (await sessionExists()) {
    console.log("✅ 大总管 session 已存在，进入监控模式");
  } else {
    await startMaster();
  }

  // 持续监控
  while (true) {
    await Bun.sleep(CHECK_INTERVAL_MS);

    if (!(await sessionExists())) {
      console.log("💀 大总管 tmux session 不存在，正在重启...");
      await startMaster();
      continue;
    }

    // 检查是否卡在确认弹窗
    const pane = await captureLast(10);
    if (hasClaudePromptToConfirm(pane)) {
      console.log("⚠️ 大总管卡在确认弹窗，自动确认...");
      await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
    }

    // 检查 Claude Code 是否还活着（不是退回了 shell）
    const atShell = /[%$]\s*$/.test(pane.split("\n").filter((l) => l.trim()).pop() || "");
    if (atShell) {
      console.log("💀 大总管退回了 shell，正在重新启动 Claude Code...");
      const cmd = buildClaudeCommand({
        channelId: CONTROL_CHANNEL_ID,
        bridgeUrl: BRIDGE_URL,
      });
      await tmuxSendLine(MASTER_WINDOW, cmd);
      // 等待确认
      for (let i = 0; i < 120; i++) {
        await Bun.sleep(500);
        const p = await captureLast(10);
        if (await isIdle()) {
          console.log("✅ 大总管已重新就绪");
          break;
        }
        if (hasClaudePromptToConfirm(p)) {
          await tmuxRaw(["send-keys", "-t", MASTER_WINDOW, "Enter"]);
          await Bun.sleep(500);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("Launcher 崩溃:", err);
  process.exit(1);
});

/**
 * 运行时权限弹窗监视器
 *
 * 轮询所有活跃 agent 的 tmux pane，检测 Claude Code 运行时权限请求
 * （Do you want to make this edit / proceed / ...）。
 * 检测到新弹窗 → 发 Discord 消息 + 截图 + 按钮，@ 用户响应。
 */

import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
} from "../lib/tmux-helper.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";

const POLL_INTERVAL_MS = 8_000;

// channelId → 最近一次通知的 modal key。防止同一弹窗重复推送。
const lastNotified = new Map<string, string>();
// channelId → Discord 消息 ID（用于点击按钮后编辑）
export const permissionMessages = new Map<string, string>();

/**
 * 给当前 modal 计算一个稳定 dedup key。
 *
 * **不要**用 pane 原文 hash —— session-idle modal 文案里有 "This session is
 * 21h 6m old and 913.2k tokens" 这种**带动态时间**的字段，每分钟跳一次，
 * 导致 watcher 每分钟重发一次"session 闲置"通知（v2.0.4 之前的 bug）。
 *
 * 改成基于语义：
 * - session-idle 这种单一状态语义就一个 key，时间变化不影响
 * - 运行时权限弹窗用 detectRuntimePermissionPrompt 返回的稳定描述
 *   （"Edit /tmp/foo" 之类，和具体权限请求 1:1）
 */
export function computeModalKey(
  sessionIdleDesc: string | null,
  permissionDesc: string | null
): string | null {
  if (sessionIdleDesc) return "session-idle";
  if (permissionDesc) return `permission|${permissionDesc}`;
  return null;
}

async function checkAgent(
  agentName: string,
  channelId: string,
  allowedUserIds: string[],
  discord: Client
) {
  const pane = await tmuxCapture(windowTarget(agentName), 30);

  // 两种弹窗共用一个 channel 级别的 slot，同时只会有一种出现
  const sessionIdleDesc = detectSessionIdlePrompt(pane);
  const permissionDesc = sessionIdleDesc ? null : detectRuntimePermissionPrompt(pane);

  const key = computeModalKey(sessionIdleDesc, permissionDesc);
  if (!key) {
    lastNotified.delete(channelId);
    return;
  }
  if (lastNotified.get(channelId) === key) return;
  lastNotified.set(channelId, key);

  const pngPath = await tmuxScreenshot(agentName);
  const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");

  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;

    let text: string;
    let components: any;
    let logLabel: string;

    if (sessionIdleDesc) {
      text = [
        `💤 **${agentName}** session 已闲置，Claude Code 询问如何继续`,
        sessionIdleDesc,
        mention,
      ].filter(Boolean).join("\n");
      components = buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `session_summary:${channelId}`, label: "从摘要恢复", emoji: "✨", style: "success" },
            { id: `session_full:${channelId}`, label: "恢复完整会话", emoji: "📜", style: "primary" },
            { id: `session_noask:${channelId}`, label: "不再询问", emoji: "🔕", style: "secondary" },
          ],
        },
      ]);
      logLabel = `session-idle desc="${sessionIdleDesc}"`;
    } else {
      text = [
        `🔔 **${agentName}** 需要授权`,
        permissionDesc,
        mention,
      ].filter(Boolean).join("\n");
      components = buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `perm_allow:${channelId}`, label: "允许", emoji: "✅", style: "success" },
            { id: `perm_allow_session:${channelId}`, label: "允许 + 本会话不再问", emoji: "✅", style: "primary" },
            { id: `perm_deny:${channelId}`, label: "拒绝", emoji: "❌", style: "danger" },
          ],
        },
      ]);
      logLabel = `permission desc="${permissionDesc}"`;
    }

    const msg = await ch.send({
      content: text,
      components,
      files: pngPath ? [{ attachment: pngPath }] : undefined,
    });
    permissionMessages.set(channelId, msg.id);
    console.log(`🔔 弹窗通知 agent=${agentName} ${logLabel}`);
  } catch (e) {
    console.error(`🔔 弹窗通知发送失败:`, e);
  }
}

export function startPermissionWatcher(
  allowedUserIds: string[],
  discord: Client
) {
  const tick = async () => {
    try {
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        // 注意：不能根据 idle 字段跳过 — 弹窗界面底部也有 ❯ 会被误判为 idle
        await checkAgent(agent.name, agent.channelId, allowedUserIds, discord).catch(() => {});
      }
    } catch { /* non-critical */ }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`🔔 权限弹窗 watcher 启动 (每 ${POLL_INTERVAL_MS / 1000}s 轮询)`);
}

export function clearPermissionMessage(channelId: string) {
  permissionMessages.delete(channelId);
  lastNotified.delete(channelId);
}

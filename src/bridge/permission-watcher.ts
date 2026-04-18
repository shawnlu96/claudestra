/**
 * 运行时权限弹窗监视器
 *
 * 轮询所有活跃 agent 的 tmux pane，检测 Claude Code 运行时权限请求
 * （Do you want to make this edit / proceed / ...）。
 * 检测到新弹窗 → 发 Discord 消息 + 截图 + 按钮，@ 用户响应。
 */

import { createHash } from "crypto";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
} from "../lib/tmux-helper.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";

const POLL_INTERVAL_MS = 8_000;

// channelId → 最近一次通知的弹窗指纹。防止同一弹窗重复推送。
const lastNotified = new Map<string, string>();
// channelId → Discord 消息 ID（用于点击按钮后编辑）
export const permissionMessages = new Map<string, string>();

function fingerprint(pane: string): string {
  // 取最后 20 行作为指纹（弹窗通常在底部）。这样用户在弹窗界面下不会有新内容进来。
  const tail = pane.split("\n").slice(-20).join("\n");
  return createHash("sha1").update(tail).digest("hex").slice(0, 16);
}

async function checkAgent(
  agentName: string,
  channelId: string,
  allowedUserIds: string[],
  discord: Client
) {
  const pane = await tmuxCapture(windowTarget(agentName), 30);
  const promptDesc = detectRuntimePermissionPrompt(pane);
  if (!promptDesc) {
    // 弹窗消失了，清掉指纹让下次新弹窗能再次通知
    lastNotified.delete(channelId);
    return;
  }

  const fp = fingerprint(pane);
  if (lastNotified.get(channelId) === fp) return; // 同一弹窗，已通知过
  lastNotified.set(channelId, fp);

  // 截图
  const pngPath = await tmuxScreenshot(agentName);

  // 通知
  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
    const text = [
      `🔔 **${agentName}** 需要授权`,
      `${promptDesc}`,
      mention,
    ].filter(Boolean).join("\n");
    const components = buildComponents([
      {
        type: "buttons",
        buttons: [
          { id: `perm_allow:${channelId}`, label: "允许", emoji: "✅", style: "success" },
          { id: `perm_allow_session:${channelId}`, label: "允许 + 本会话不再问", emoji: "✅", style: "primary" },
          { id: `perm_deny:${channelId}`, label: "拒绝", emoji: "❌", style: "danger" },
        ],
      },
    ]);
    const msg = await ch.send({
      content: text,
      components,
      files: pngPath ? [{ attachment: pngPath }] : undefined,
    });
    permissionMessages.set(channelId, msg.id);
    console.log(`🔔 权限弹窗通知: agent=${agentName} desc="${promptDesc}"`);
  } catch (e) {
    console.error(`🔔 权限弹窗通知发送失败:`, e);
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

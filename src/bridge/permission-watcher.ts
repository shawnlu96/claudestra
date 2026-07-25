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
  tmuxRaw,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
} from "../lib/tmux-helper.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";

const POLL_INTERVAL_MS = 8_000;

// v2.7+ agents 视图自动逃逸的通知去重（channelId → 上次通知时间戳）
const agentsViewNotifiedAt = new Map<string, number>();
const AGENTS_VIEW_NOTIFY_COOLDOWN_MS = 10 * 60_000;

/**
 * v2.7+ 自动逃逸：agent 窗口误入 Claude Code 的 agents 视图 / bg 派发界面。
 *
 * 空输入框按 ← 会进 agents 视图；在里面切换会话会把当前会话 fork 成 bg job、
 * 窗口变 attach 旁观视图，Discord/MCP 链路断掉（2026-07-09 事故）。上游没有
 * 禁用开关（keybindings 管不到、settings 无相关键），只能事后秒级拉回：
 * 检测 dispatch 界面特征 → 发 Esc 退回对话界面 → 通知频道。
 * Esc 对正常对话界面无害（顶多取消未提交输入），误判代价低。
 */
async function maybeEscapeAgentsView(
  agentName: string,
  channelId: string,
  pane: string,
  discord: Client,
): Promise<boolean> {
  const inAgentsView =
    pane.includes("describe a task for a new session") ||
    (pane.includes("enter to collapse") && pane.includes("delete all"));
  if (!inAgentsView) return false;

  const target = windowTarget(agentName);
  console.log(`🏃 ${agentName} 误入 agents 视图，自动 Esc 逃逸`);
  await tmuxRaw(["send-keys", "-t", target, "Escape"]);
  await Bun.sleep(1_000);
  const after = await tmuxCapture(target, 30);
  if (after.includes("describe a task for a new session")) {
    await tmuxRaw(["send-keys", "-t", target, "Escape"]);
  }

  const last = agentsViewNotifiedAt.get(channelId) ?? 0;
  if (Date.now() - last > AGENTS_VIEW_NOTIFY_COOLDOWN_MS) {
    agentsViewNotifiedAt.set(channelId, Date.now());
    try {
      const ch = (await discord.channels.fetch(channelId)) as TextChannel;
      await ch.send(
        `🏃 **${agentName}** 的窗口误入了 agents 视图（按了 ←？），已自动 Esc 拉回对话界面。` +
          `如果切换动作已把会话派发成 bg 分身，稍后对账告警会带清理/收编按钮。`,
      );
    } catch { /* non-critical */ }
  }
  return true;
}

// v2.0.23+: session-idle 兜底 grace。manager.ts/launcher.ts 启动路径会自动选
// 「恢复完整会话」，几秒内消掉 modal。watcher 不该抢在它前面发按钮（重启时
// 每个 agent 都会闪一下 modal → 一堆 @ 你的噪音通知，但 modal 早被自动消了）。
// 只有 modal 撑过这个 grace 还在（说明自动选真失败了）才发按钮兜底。
const SESSION_IDLE_GRACE_MS = 20_000;

// channelId → 最近一次通知的 modal key。防止同一弹窗重复推送。
const lastNotified = new Map<string, string>();
// channelId → 首次看到 session-idle modal 的时间戳（grace 计时用）
const sessionIdleFirstSeen = new Map<string, number>();
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

  // v2.7+ agents 视图自动逃逸（特征界面刚被 Esc 掉 → 本轮不再做弹窗检测）
  if (await maybeEscapeAgentsView(agentName, channelId, pane, discord)) return;

  // 两种弹窗共用一个 channel 级别的 slot，同时只会有一种出现
  const sessionIdleDesc = detectSessionIdlePrompt(pane);
  const permissionDesc = sessionIdleDesc ? null : detectRuntimePermissionPrompt(pane);

  // v2.0.23+: session-idle grace —— 启动路径会自动选「完整恢复」消掉 modal。
  // modal 没撑过 grace 就不发按钮（避免重启 race 噪音）；撑过了才兜底。
  if (!sessionIdleDesc) {
    sessionIdleFirstSeen.delete(channelId);
  } else {
    const firstSeen = sessionIdleFirstSeen.get(channelId);
    if (firstSeen === undefined) {
      sessionIdleFirstSeen.set(channelId, Date.now());
      return; // 第一次看到，给自动选留时间，先不发
    }
    if (Date.now() - firstSeen < SESSION_IDLE_GRACE_MS) return; // 还在 grace 内
    // 撑过 grace 仍在 → 自动选大概率失败，往下走正常发按钮兜底
  }

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
  // 重入保护。tick 会 runManager("list") + 对每个 active agent 各 capture 一次 pane，
  // agent 一多、或 tmux/manager 变慢，单轮就可能超过 8s 的间隔 —— 没有这个闸，
  // setInterval 会让轮次叠罗汉，每轮各自持有一串子进程。bg-activity-watcher 和
  // stats-dashboard 早就是这么做的，这里一直漏了。
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        // 注意：不能根据 idle 字段跳过 — 弹窗界面底部也有 ❯ 会被误判为 idle
        await checkAgent(agent.name, agent.channelId, allowedUserIds, discord).catch(() => {});
      }
    } catch { /* non-critical */ } finally {
      // 必须在 finally 里放闸：任何一条异常路径漏掉它，watcher 就永久锁死再不工作。
      ticking = false;
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`🔔 权限弹窗 watcher 启动 (每 ${POLL_INTERVAL_MS / 1000}s 轮询)`);
}

export function clearPermissionMessage(channelId: string) {
  permissionMessages.delete(channelId);
  lastNotified.delete(channelId);
  sessionIdleFirstSeen.delete(channelId);
}

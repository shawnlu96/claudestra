/**
 * Wedge Watcher — 卡死 agent 检测
 *
 * 定期扫所有 active agent 的 tmux pane。如果 pane 指纹（最后 40 行 hash）
 * 连续 30 分钟不变，并且 agent 不在 idle 状态（没有 `❯` 提示符），
 * 说明它很可能卡在某个状态（模态、网络、Claude 无响应等），
 * 通过 Discord 通知用户 + 给一个 "发 Esc 救回" 按钮。
 */

import { createHash } from "crypto";
import type { Client, TextChannel } from "discord.js";
import {
  tmuxCapture,
  windowTarget,
  isIdle,
} from "../lib/tmux-helper.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_INTERVAL_MS = 5 * 60_000;     // 每 5 分钟扫一次
const WEDGE_THRESHOLD_MS = 30 * 60_000;  // 30 分钟没变 + 非 idle → 判定卡死

interface AgentState {
  fingerprint: string;
  firstSeenAt: number;   // 该指纹第一次出现的时间
  notifiedAt: number;    // 上次通知时间（避免重复打扰）
}

const agentStates = new Map<string, AgentState>(); // agentName → state

function fingerprint(pane: string): string {
  const tail = pane.split("\n").slice(-40).join("\n");
  return createHash("sha1").update(tail).digest("hex").slice(0, 16);
}

async function checkAgent(
  agentName: string,
  channelId: string,
  allowedUserIds: string[],
  discord: Client
): Promise<void> {
  const target = windowTarget(agentName);
  const pane = await tmuxCapture(target, 40);
  const fp = fingerprint(pane);
  const now = Date.now();

  // idle → 不是卡死，是完成态。清掉状态。
  if (await isIdle(target)) {
    agentStates.delete(agentName);
    return;
  }

  const prev = agentStates.get(agentName);
  if (!prev || prev.fingerprint !== fp) {
    // 指纹变了 → 有进展。重新开始计时
    agentStates.set(agentName, { fingerprint: fp, firstSeenAt: now, notifiedAt: 0 });
    return;
  }

  // 指纹一直没变 → 检查是否到阈值
  const stuckMs = now - prev.firstSeenAt;
  if (stuckMs < WEDGE_THRESHOLD_MS) return;
  // 已通知过且上一次通知在 1 小时内 → 不打扰
  if (prev.notifiedAt > 0 && now - prev.notifiedAt < 60 * 60_000) return;

  console.log(`⚠️ 检测到 agent ${agentName} 可能卡死了（${Math.round(stuckMs / 60_000)} 分钟无变化）`);
  prev.notifiedAt = now;
  recordMetric("agent_wedged", { channelId, agent: agentName, durationMs: stuckMs });

  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
    const minutes = Math.round(stuckMs / 60_000);
    await ch.send({
      content: [
        `⚠️ **${agentName}** 好像卡住了${mention ? " " + mention : ""}`,
        `pane 已 ${minutes} 分钟没有任何变化，但 Claude Code 又不是 idle 状态。`,
        `可能是：modal 没关、网络挂了、Claude API 超时、或者跑进死循环。`,
        ``,
        `👉 用下面按钮 Esc/C-c 救回，或 /screenshot 看看现在是什么状态。`,
      ].join("\n"),
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `wedge_esc:${agentName}`, label: "发 Esc", emoji: "❌", style: "secondary" },
            { id: `interrupt:${channelId}`, label: "发 Ctrl+C", emoji: "⚡", style: "danger" },
          ],
        },
      ]),
    });
  } catch (e) {
    console.error(`⚠️ wedge 通知发送失败:`, e);
  }
}

export function startWedgeWatcher(discord: Client) {
  const tick = async () => {
    try {
      const allowedUserIds = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        await checkAgent(agent.name, agent.channelId, allowedUserIds, discord).catch(() => {});
      }
    } catch { /* non-critical */ }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`⚠️ Wedge watcher 启动（每 ${POLL_INTERVAL_MS / 60_000}min 扫，${WEDGE_THRESHOLD_MS / 60_000}min 卡死阈值）`);
}

/** 清掉 agent 状态，agent 被 kill 时可调用 */
export function clearWedgeState(agentName: string) {
  agentStates.delete(agentName);
}

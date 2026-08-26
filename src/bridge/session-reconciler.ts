/**
 * v2.7+ bg 对账定时器 —— Claude Code agents 模式适配的检测层。
 *
 * 周期性跑 SessionsInventory，发现正式 agent 冒出 bg 分身（典型来源：agents
 * 视图误触把会话 fork 派发成 bg job）→ 发 Discord 告警到该 agent 的频道，
 * 带 [⤴️ 收编] / [🗑 清理] 按钮（复用 management.ts 的 sess_adopt: / sess_cleanup:
 * 处理器），并 emit session_anomaly 进事件流（SSE / web 前端同步可见）。
 *
 * 去重：内存 Set 记录已告警的 bgId，分身消失（被清理/收编）后自动移除，
 * 同一分身不重复轰炸。bridge 重启清零 → 残留分身会再报一次，可接受。
 */

import type { Client, TextChannel } from "discord.js";
import {
  collectSessions,
  doppelgangers,
  readRegistryLite,
} from "./sessions-inventory.js";
import { emitEvent } from "./event-bus.js";
import { buildComponents } from "./components.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_INTERVAL_MS = 10 * 60_000; // 每 10 分钟对账一次

/** 已告警的分身 bgId（消失后移除，允许再次出现时重新告警） */
const alerted = new Set<string>();

async function tick(discord: Client): Promise<void> {
  const list = await collectSessions();
  if (list === null) return; // claude CLI 不可用，静默跳过
  const dops = doppelgangers(list);

  // 已消失的分身从告警集合移除
  const liveIds = new Set(dops.map((d) => d.bgId).filter(Boolean) as string[]);
  for (const id of alerted) {
    if (!liveIds.has(id)) alerted.delete(id);
  }

  if (dops.length === 0) return;
  const registry = await readRegistryLite();

  for (const d of dops) {
    if (!d.bgId || alerted.has(d.bgId)) continue;
    alerted.add(d.bgId);
    const owner = d.doppelgangerOf!;
    console.log(`🧬 对账发现分身: ${d.name}(${d.bgId}) ⚠ of ${owner}`);
    recordMetric("doppelganger_detected", { agent: owner, meta: { bgId: d.bgId } });
    emitEvent({
      agent: owner,
      chatId: registry.find((a) => a.name === owner)?.channelId ?? "",
      type: "session_anomaly",
      data: {
        kind: "doppelganger_detected",
        bgId: d.bgId,
        sessionId: d.sessionId,
        status: d.status,
        reason: d.doppelgangerReason,
      },
    });

    // Discord 告警发到该 agent 自己的频道（没频道就跳过，事件流里仍可见）
    const channelId = registry.find((a) => a.name === owner)?.channelId;
    if (!channelId) continue;
    try {
      const ch = (await discord.channels.fetch(channelId)) as TextChannel;
      await ch.send({
        content: [
          `🧬 **发现 ${owner.replace("agent-", "")} 的 bg 分身** \`${d.bgId}\`（${d.status}）`,
          `多半是 agents 视图误触 fork 出来的。分身与正式会话会各自演化，建议尽快处置：`,
          `· 分身没干过活 → **清理**`,
          `· 分身上下文更新（你在里面聊过）→ **收编**（fork 替换正式会话，上下文不丢）`,
        ].join("\n"),
        components: buildComponents([
          {
            type: "buttons",
            buttons: [
              { id: `sess_cleanup:${d.bgId}`, label: "清理分身", emoji: "🗑", style: "danger" },
              { id: `sess_adopt:${d.bgId}`, label: "收编替换", emoji: "⤴️", style: "primary" },
              { id: "show_sessions_panel", label: "看全部会话", emoji: "🧬", style: "secondary" },
            ],
          },
        ]),
      });
    } catch (e) {
      console.error("🧬 分身告警发送失败:", e);
    }
  }
}

export function startSessionReconciler(discord: Client): void {
  // 重入闸(Codex review 2026-08-26):inventory 收集慢于周期时不叠加并发轮
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick(discord).catch(() => {}).finally(() => { running = false; });
  }, POLL_INTERVAL_MS);
  // 启动后 1 分钟先跑一轮（bridge 重启后尽快发现存量分身）
  setTimeout(() => tick(discord).catch(() => {}), 60_000);
  console.log(`🧬 Session 对账器启动（每 ${POLL_INTERVAL_MS / 60_000}min 扫 bg 分身）`);
}

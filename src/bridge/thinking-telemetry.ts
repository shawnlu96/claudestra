/**
 * v2.15+ 思考遥测轮询（owner 2026-07-27「思考状态富化 + 真卡死检测」）。
 *
 * agent 处于回合中（event-bus agent_status = thinking）时，每 3s capture 其
 * tmux pane 尾部，解析 TUI spinner 状态行（lib/thinking-status.ts）：
 * - 解析结果以 transient 事件 `thinking_telemetry` 发布——web 的「思考中」
 *   徽章据此显示 `47s · ↓ 2.1k tokens`，token 在跳 = 模型活着；
 * - StallTracker 盯 token 计数：出 token 后冻结 ≥8min = 真卡死（spinner 的
 *   计时是 TUI 本地渲染的，网络挂死照样走，耗时不能当活性信号），告警一次
 *   （Discord 频道文本 + session_anomaly kind=stalled），比 wedge-watcher 的
 *   30min pane-diff 粗筛灵敏得多。纯思考阶段（还没有 ↓）不参与卡死判定，
 *   那段的兜底仍归 wedge-watcher。
 *
 * 空闲 agent 零开销：不在 thinking 态的连 capture 都不做。
 */

import { emitEvent, getAgentStatus } from "./event-bus.js";
import { tmuxCapture, windowTarget, MASTER_SESSION } from "../lib/tmux-helper.js";
import { parseThinkingStatus, StallTracker } from "../lib/thinking-status.js";

const POLL_MS = 3_000;
const STALL_MS = 8 * 60_000;

export interface TelemetryDeps {
  /** 活跃 agent 花名册（bridge 注入，registry 缓存 + master） */
  roster: () => Array<{ name: string; channelId: string }>;
  /** stalled 告警投递（UI-class 通知，bridge 注入 Discord 发送；可缺省） */
  notify?: (channelId: string, text: string) => void;
}

export function startThinkingTelemetry(deps: TelemetryDeps): void {
  const tracker = new StallTracker(STALL_MS);

  const tick = async () => {
    let entries: Array<{ name: string; channelId: string }>;
    try {
      entries = deps.roster();
    } catch {
      return;
    }
    for (const { name, channelId } of entries) {
      const bare = name.replace(/^agent-/, "");
      const status = getAgentStatus(name) ?? getAgentStatus(bare);
      if (status !== "thinking") {
        tracker.clear(bare);
        continue;
      }
      try {
        const target = bare === "master" ? `${MASTER_SESSION}:0` : windowTarget(name);
        const pane = await tmuxCapture(target, 15);
        const st = parseThinkingStatus(pane);
        if (st) {
          emitEvent(
            {
              agent: bare,
              chatId: channelId,
              type: "thinking_telemetry",
              data: {
                elapsedSec: st.elapsedSec,
                elapsedRaw: st.elapsedRaw,
                tokens: st.tokens,
                effort: st.effort,
                verb: st.verb,
              },
            },
            { transient: true },
          );
        }
        if (tracker.sample(bare, st)) {
          const mins = Math.round(tracker.frozenFor(bare) / 60_000);
          console.log(`🧊 [telemetry] ${bare} 输出 token 已冻结 ${mins}min（疑似卡死）`);
          emitEvent({
            agent: bare,
            chatId: channelId,
            type: "session_anomaly",
            data: {
              kind: "stalled",
              minutes: mins,
              tokens: st?.tokens ?? null,
              elapsed: st?.elapsedRaw ?? null,
              hint: "输出 token 长时间不动——可能网络/进程挂死。可 Interrupt 或 /screenshot 查看现场。",
            },
          });
          deps.notify?.(
            channelId,
            `🧊 **疑似卡死**：回合进行中，但输出 token 计数已 ${mins} 分钟纹丝不动` +
              `（停在 ↓ ${st?.tokens ?? "?"} tokens · 已跑 ${st?.elapsedRaw ?? "?"}）。` +
              `建议点 Interrupt 中断重试，或 /screenshot 看现场。`,
          );
        }
      } catch {
        /* 窗口不存在/tmux 抖动:跳过本轮 */
      }
    }
  };

  setInterval(() => void tick(), POLL_MS).unref?.();
  console.log(`🧠 Thinking telemetry 启动（${POLL_MS / 1000}s 采样，${STALL_MS / 60_000}min 冻结告警）`);
}

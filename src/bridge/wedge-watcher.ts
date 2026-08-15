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
  isAtShell,
  idleVerdict,
  windowHasChildProcess,
} from "../lib/tmux-helper.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";
import { getJsonlMtime } from "./jsonl-watcher.js";
import { recordMetric } from "../lib/metrics.js";
import { emitEvent } from "./event-bus.js";

const POLL_INTERVAL_MS = 5 * 60_000;     // 每 5 分钟扫一次
const WEDGE_THRESHOLD_MS = 30 * 60_000;  // 30 分钟没变 + claude 在跑但非 idle → 卡死
// claude 退出停在 shell 撑过这个才报"掉线"。比 wedge 阈值短（掉线要早点知道），
// 但留 grace 滤掉正常 restart 的瞬时 shell 窗口（restart 几十秒内就拉起新 claude）。
const SHELL_EXIT_GRACE_MS = 10 * 60_000;

interface AgentState {
  fingerprint: string;
  firstSeenAt: number;   // 该指纹第一次出现的时间
  notifiedAt: number;    // 上次通知时间（避免重复打扰）
}

const agentStates = new Map<string, AgentState>(); // agentName → state

// v2.7+ 链路哨兵：agentName → 首次发现 channel-server 掉线的时间戳
const linkDownSince = new Map<string, number>();
const linkNotifiedAt = new Map<string, number>();
const LINK_DOWN_THRESHOLD_MS = 5 * 60_000;   // 掉线 5 分钟才报（滤掉重启瞬时）
const LINK_NOTIFY_COOLDOWN_MS = 60 * 60_000; // 同一 agent 一小时最多报一次

function fingerprint(pane: string): string {
  const tail = pane.split("\n").slice(-40).join("\n");
  return createHash("sha1").update(tail).digest("hex").slice(0, 16);
}

/**
 * v2.7+ 链路哨兵：tmux 窗口活着（claude 在跑）但该频道没有 channel-server
 * 连到 bridge —— 用户消息进不来、agent 回复出不去，从 Discord 看是「静默失联」。
 * 典型成因：agents 视图误触把前台会话换掉、channel-server 崩溃、MCP 配置丢失。
 * 卡死检测靠 pane 指纹管不到这种（agent 可能正常干活甚至 idle）。
 */
async function checkLink(
  agentName: string,
  channelId: string,
  pane: string,
  connected: boolean,
  allowedUserIds: string[],
  discord: Client,
): Promise<void> {
  const now = Date.now();
  if (connected || isAtShell(pane) || !pane.trim()) {
    // 在线，或 claude 根本没跑（at-shell / 空白 pane 有专门的掉线通知）→ 清计时。
    // 空白 pane = claude 退出后 clear 过的 shell（2026-07-09 migration 实例：
    // 误报成"链路断开（Claude 在跑）"，其实早就退出了）。
    linkDownSince.delete(agentName);
    return;
  }
  const since = linkDownSince.get(agentName);
  if (!since) {
    linkDownSince.set(agentName, now);
    return;
  }
  if (now - since < LINK_DOWN_THRESHOLD_MS) return;
  const lastNotify = linkNotifiedAt.get(agentName) ?? 0;
  if (now - lastNotify < LINK_NOTIFY_COOLDOWN_MS) return;
  linkNotifiedAt.set(agentName, now);

  const minutes = Math.round((now - since) / 60_000);
  console.log(`🔗 ${agentName} 链路断开 ${minutes} 分钟（窗口活着但 channel-server 不在线）`);
  recordMetric("agent_link_down", { channelId, agent: agentName, durationMs: now - since });
  // v2.14+ 也推 SSE。此前这条告警**只发 Discord 频道** —— 而 Web 端用户恰恰是最
  // 需要它的那批人：MCP 一断，agent 既收不到消息也发不出回复，Web 界面上却没有
  // 任何提示，只能干等（owner 2026-07-25 连续踩了一整天）。
  // 类型用 session_anomaly：它的注释里本来就写了「链路掉线」，只是一直没实现。
  emitEvent({
    agent: agentName,
    chatId: channelId,
    type: "session_anomaly",
    data: {
      kind: "link_down",
      minutes,
      since: new Date(since).toISOString(),
      hint: "tmux 窗口里 Claude Code 在跑，但 channel-server 没连上 bridge —— 消息进不来也出不去。重启该 agent 可修复。",
    },
  });
  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
    await ch.send({
      content: [
        `🔗 **${agentName}** 链路断开${mention ? " " + mention : ""}`,
        `tmux 窗口里 Claude Code 在跑，但已 ${minutes} 分钟没有 channel-server 连到 bridge —— Discord 消息进不来也出不去。`,
        `可能是 agents 视图误触换掉了前台会话、channel-server 崩溃、或 MCP 配置丢失。`,
        ``,
        `👉 点重启自动修复（session 被 bg 占用会自动 fork 恢复，上下文不丢）。`,
      ].join("\n"),
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `wedge_restart:${agentName}`, label: "重启修复", emoji: "🔀", style: "primary" },
          ],
        },
      ]),
    });
  } catch (e) {
    console.error(`🔗 链路告警发送失败:`, e);
  }
}

async function checkAgent(
  agentName: string,
  channelId: string,
  cwd: string,
  sessionId: string,
  allowedUserIds: string[],
  discord: Client,
  isChannelConnected?: (channelId: string) => boolean,
): Promise<void> {
  const target = windowTarget(agentName);
  const pane = await tmuxCapture(target, 40);
  const fp = fingerprint(pane);
  const now = Date.now();

  // v2.7+ 链路哨兵先行：idle 也可能失联（idle + 掉线 = 用户消息进不来，更要报）
  if (isChannelConnected) {
    await checkLink(
      agentName, channelId, pane, isChannelConnected(channelId), allowedUserIds, discord,
    ).catch(() => {});
  }

  // idle（ready 提示符）→ 正常歇着，不是卡死。清掉状态。
  // 三态：契约可疑（CC 可能改了底部文案）时按 idle 处理 —— 文案一变会让**所有**
  // agent 同时被判成"非 idle"，那就是一轮全员误报刷屏。宁可漏报一次真卡死。
  const verdict = await idleVerdict(target);
  if (verdict === "idle" || verdict === "unknown") {
    if (verdict === "unknown") {
      console.warn(`⚠️ [wedge] ${agentName} 忙闲判据失效（TUI 文案可能已变），本轮按 idle 处理`);
    }
    agentStates.delete(agentName);
    return;
  }

  // v2.0.23+: claude 已退出停在 shell —— 你的 zsh 主题 shell 提示符是 ❯，跟 claude
  // 输入框同符号，paneLooksIdle 看到 ❯ 但没 bypass banner → 误判"非 idle 卡死"，
  // 对一个根本没 claude 在跑的 window 每小时误报。这是掉线不是卡死：Esc/C-c 没用，
  // 要的是重启。下面按 atShell 分流到不同通知 + 不同阈值。
  // 空白 pane 同样按已退出处理（claude 退出后 clear 的 shell 没有提示符特征）。
  // "claude 是否已退出到 shell" 优先用进程树判定 —— pane 有无直接子进程是 tmux 层面的
  // 事实，跟 CC 的界面文案完全无关。文案匹配只在查不到 pane pid 时兜底（launcher 的
  // master 判活早就是这么做的，这里补齐）。少了这层，用户 shell 主题若用 ❯ 提示符，
  // 判据就完全压在"能否认出 CC 的 banner"上。
  const hasChild = await windowHasChildProcess(target);
  const atShell =
    hasChild === null ? isAtShell(pane) || !pane.trim() : !hasChild;

  // v2.0.23+: jsonl 活跃度逃生阀。Claude 思考 / 调工具时 session jsonl 一直在追加。
  // 只看 tmux pane 指纹会把"思考中但屏幕暂时没变"误判成卡死（owner 实测 claudestra
  // 自己思考时被误报）。jsonl 最近被写过 → agent 在干活，绝不是卡死，重置计时。
  // 只对"claude 在跑"分支生效：at-shell 是 claude 已退出、jsonl 本来就不更新，
  // 那条掉线检测单独按 atShell 走，不受这里影响。
  if (!atShell) {
    const mtime = await getJsonlMtime(cwd, sessionId);
    if (mtime !== null && now - mtime < WEDGE_THRESHOLD_MS) {
      agentStates.delete(agentName);
      return;
    }
  }

  const prev = agentStates.get(agentName);
  if (!prev || prev.fingerprint !== fp) {
    // 指纹变了 → 有进展 / 状态切换。重新开始计时。
    agentStates.set(agentName, { fingerprint: fp, firstSeenAt: now, notifiedAt: 0 });
    return;
  }

  // 指纹一直没变 → 到阈值才报。at-shell 用较短 grace，其余维持 30min。
  const staticMs = now - prev.firstSeenAt;
  const threshold = atShell ? SHELL_EXIT_GRACE_MS : WEDGE_THRESHOLD_MS;
  if (staticMs < threshold) return;

  // v2.19.0 只报一次（owner 2026-08-16「这里一直在 spam 我」）。
  // 原来是「上次通知超过 1 小时就再报一次」——同一次掉线会每小时 @ 一遍，
  // 2026-07-26 的 ld-binance 连报 6 次是同一个毛病。状态没变就没有新信息：
  // 按钮还在上一条消息里，人已经知道了。指纹一变（恢复了 / 换了别的状态）
  // 会重置整个 state，下次真出事照样报。
  if (prev.notifiedAt > 0) return;

  // v2.19.0 双信号佐证：只有「进程树说没子进程」**且**「pane 文本也像 shell」
  // 才算掉线。单靠进程树时，一次 tmux/ps 抖动就能伪造出「Claude Code 已退出」
  // 这种吓人且会引导用户去点重启的假警。两个信号不一致 → 记一笔，不报。
  if (atShell && hasChild === false && !(isAtShell(pane) || !pane.trim())) {
    console.warn(
      `⚠️ [wedge] ${agentName} 掉线判据不一致（进程树说无子进程，但 pane 仍是 CC 界面），本轮不报`,
    );
    return;
  }

  prev.notifiedAt = now;
  const minutes = Math.round(staticMs / 60_000);

  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");

    if (atShell) {
      // 掉线：claude 退出到 shell，发"已退出 + 重启按钮"
      // 判据一并入日志(2026-08-16 溯源教训:出现幽灵告警时,只有「报了」没有
      // 「凭什么报」,查不出是哪个信号误判的,连是不是本进程发的都证不了)
      console.log(
        `🔌 agent ${agentName} 已退出到 shell（${minutes} 分钟）` +
          ` [hasChild=${hasChild} paneAtShell=${isAtShell(pane)} paneEmpty=${!pane.trim()}]`,
      );
      recordMetric("agent_exited", { channelId, agent: agentName, durationMs: staticMs });
      await ch.send({
        content: [
          `🔌 **${agentName}** 的 Claude Code 已退出（掉线）${mention ? " " + mention : ""}`,
          `已停在 shell ${minutes} 分钟，没有 Claude Code 在跑。`,
          `可能是 /exit、崩溃、或自动更新失败。自愈巡检每分钟会尝试拉起（窗口在但没 claude 也算 dead），` +
            `拖到现在还没起来说明自愈也失败了。`,
          ``,
          `👉 点下面重启，或 /screenshot 看现在状态。这条只报一次，不会再打扰。`,
        ].join("\n"),
        components: buildComponents([
          {
            type: "buttons",
            buttons: [
              { id: `wedge_restart:${agentName}`, label: "重启", emoji: "🔄", style: "primary" },
            ],
          },
        ]),
      });
    } else {
      // 真卡死：claude 在跑但 pane 静止，发 Esc/C-c 救援
      console.log(`⚠️ 检测到 agent ${agentName} 可能卡死了（${minutes} 分钟无变化）`);
      recordMetric("agent_wedged", { channelId, agent: agentName, durationMs: staticMs });
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
    }
  } catch (e) {
    console.error(`⚠️ wedge 通知发送失败:`, e);
  }
}

export function startWedgeWatcher(
  discord: Client,
  // v2.7+ 链路哨兵：bridge 注入「该频道是否有 channel-server 在线」的查询
  isChannelConnected?: (channelId: string) => boolean,
) {
  const tick = async () => {
    try {
      const allowedUserIds = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        await checkAgent(
          agent.name, agent.channelId, agent.cwd || "", agent.sessionId || "",
          allowedUserIds, discord, isChannelConnected,
        ).catch(() => {});
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

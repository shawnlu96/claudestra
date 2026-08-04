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

/** 粗粒度模型家族提取（opus/sonnet/haiku/fable）——「Switch model?」守卫用。 */
export function modelFamilies(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/\b(fable|opus|sonnet|haiku)\b/g)) out.add(m[1]);
  return out;
}

/** v2.16.2 切模型意图表(peer 2026-08-04 三层根因报告的核心修复):bridge 自己
 *  注入 /model 时登记「agent → 目标家族」,watcher 见弹窗先对意图——匹配即代按。
 *  家族守卫无法区分「用户主动换族」和「CC 主动提议降级」(弹窗长得一模一样),
 *  意图关联可以:我们注入的 = 用户拍过板的;没有意图的弹窗 = CC 自己弹的。
 *  TTL 2h:/model 在 agent 忙时会排队到回合结束才弹(2026-07-28 实锤迟到数十分钟),
 *  60s 级 TTL 会漏;匹配即消费,一条意图只用一次。 */
const SWITCH_INTENT_TTL_MS = 2 * 3600_000;
const switchIntents = new Map<string, { families: Set<string>; ts: number }>();

/** 注入 /model 的三条路径(web slash 直通/Discord slash/claude-settings)都要调。 */
export function noteModelSwitchIntent(agentName: string, modelStr: string) {
  const families = modelFamilies(modelStr);
  if (!families.size) return; // 目标解析不出家族(裸别名之外的自定义 id)→ 不登记,走保守路径
  switchIntents.set(agentName, { families, ts: Date.now() });
}

function consumeSwitchIntent(agentName: string, dialogFamilies: Set<string>): boolean {
  const it = switchIntents.get(agentName);
  if (!it) return false;
  if (Date.now() - it.ts > SWITCH_INTENT_TTL_MS) {
    switchIntents.delete(agentName);
    return false;
  }
  const hit = [...it.families].some((f) => dialogFamilies.has(f));
  if (hit) switchIntents.delete(agentName);
  return hit;
}

/**
 * v2.15.2+「Switch model?」确认弹窗处理。
 *
 * 初版无脑代按 Yes，前提是「弹窗只由明确的 /model 操作触发」——这个前提是错的：
 * Claude Code 在用量保护场景会**主动**弹同款对话框提议降级（Pro 计划降到
 * Sonnet 4.6），无脑 Enter 等于替用户答应降级（2026-07-30 外部用户报
 * 「莫名其妙被切到 Sonnet 4.6」，本守卫防的正是这个放大器）。
 *
 * 现在按弹窗块提到的模型家族分流：
 * - registry 钉了模型，且弹窗块**只**涉及钉的家族 → 这是钉模型流程自己的
 *   迟到确认框（2026-07-28 实锤场景），代按 Yes 无害；
 * - 弹窗涉及其他家族（CC 主动提议降级）或根本没钉模型 → **绝不代按**，
 *   发通知带 按/不按 按钮，用户拍板。
 */
async function maybeConfirmSwitchModel(
  agentName: string,
  channelId: string,
  pane: string,
  allowedUserIds: string[],
  discord: Client
): Promise<boolean> {
  if (!pane.includes("Switch model?") || !/Yes,\s*switch/i.test(pane)) return false;

  // 只看弹窗块（标题行起 ~12 行）——上方对话正文里提到的模型名不算数
  const block = pane.slice(pane.indexOf("Switch model?")).split("\n").slice(0, 12).join("\n");
  const mentioned = modelFamilies(block);

  // v2.16.2 意图优先(peer 报告根因 2:家族守卫把用户主动换族误判成 CC 降级提议,
  // 89999c1 后自动确认实际只剩「重钉同族」一种场景生效):bridge 注入过 /model
  // 且弹窗提到目标家族 → 这就是用户拍过板的那次切换,代按。
  if (consumeSwitchIntent(agentName, mentioned)) {
    console.log(`🎛 ${agentName} 「Switch model?」命中切换意图(${[...mentioned].join("/")}),自动代按 Yes`);
    await tmuxRaw(["send-keys", "-t", windowTarget(agentName), "Enter"]);
    return true;
  }

  let pinnedFamily: string | null = null;
  try {
    const { readRegistryAgents } = await import("../lib/registry.js");
    const { resolveModelAlias } = await import("../lib/claude-launch.js");
    const info = (await readRegistryAgents()).find((r) => r.name === agentName);
    if (info?.model) pinnedFamily = [...modelFamilies(resolveModelAlias(info.model))][0] ?? null;
  } catch { /* registry 读不到按未钉处理 */ }

  const foreign = [...mentioned].filter((f) => f !== pinnedFamily);
  if (pinnedFamily && foreign.length === 0) {
    console.log(`🎛 ${agentName} 停在「Switch model?」弹窗（仅涉及钉定家族 ${pinnedFamily}），自动代按 Yes`);
    await tmuxRaw(["send-keys", "-t", windowTarget(agentName), "Enter"]);
    return true;
  }

  // CC 主动提议 / 未钉模型 → 通知用户拍板（dedup 按涉及家族）
  const key = `swmodel|${[...mentioned].sort().join(",")}`;
  if (lastNotified.get(channelId) === key) return true;
  lastNotified.set(channelId, key);
  console.log(`🎛 ${agentName} 弹「Switch model?」但涉及 ${[...mentioned].join("/") || "未知"} ≠ 钉定 ${pinnedFamily ?? "(未钉)"}，不代按，通知用户`);
  // v2.16.2 web 可见(peer 报告根因 3:通知只走 Discord 直发,web 用户零提示
  // 只看到 agent 卡死):同步 emit session_anomaly,BFF 翻译成系统文本。
  try {
    const { emitEvent } = await import("./event-bus.js");
    emitEvent({
      agent: agentName,
      chatId: channelId,
      type: "session_anomaly",
      data: { kind: "switch_model_prompt", families: [...mentioned], pinned: pinnedFamily },
    });
  } catch { /* 事件失败不影响 Discord 通知 */ }
  try {
    const pngPath = await tmuxScreenshot(agentName);
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const msg = await ch.send({
      content: [
        `🎛 **${agentName}** 弹出「Switch model?」——像是 Claude Code 主动提议换模型（常见于用量保护降级）。`,
        `我没有代按。要切就点「切换」，想保住当前模型点「不切」。`,
        mention,
      ].join("\n"),
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `swmodel_no:${agentName}`, label: "不切,保持现状", emoji: "🛡", style: "primary" },
            { id: `swmodel_yes:${agentName}`, label: "切换", emoji: "🔁", style: "secondary" },
          ],
        },
      ]),
      files: pngPath ? [{ attachment: pngPath }] : undefined,
    });
    permissionMessages.set(channelId, msg.id);
  } catch (e) {
    console.error(`🎛 Switch model 通知发送失败:`, e);
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

/** v2.16.4 服务端 thinking 反向对账:channelId → 首次观测到「事件态 thinking
 *  但 pane 空闲」的时刻。2026-08-04 实锤:一条推回消息投递即点亮 thinking,
 *  但会话从未收到、回合从未开始,thinking 挂死 27 分钟——web 永远思考中、
 *  新消息还会误触抢占打断。web 客户端的反向对齐救不了这种,因为它信任的
 *  正是服务端 busy。 */
const idleWhileThinking = new Map<string, number>();
const IDLE_THINKING_GRACE_MS = 120_000;

async function checkAgent(
  agentName: string,
  channelId: string,
  allowedUserIds: string[],
  discord: Client
) {
  const pane = await tmuxCapture(windowTarget(agentName), 30);

  // thinking 反向对账:pane 空闲(❯ 在场且无 esc to interrupt)而事件态仍
  // thinking,连续 2 分钟 → 强制发 done 收敛。真回合的间隙(工具间/流转)
  // 不会持续 2 分钟空闲提示符,不误伤。
  try {
    const { getAgentStatus, emitEvent } = await import("./event-bus.js");
    const paneIdleNow = /❯/.test(pane) && !/esc to interrupt/i.test(pane);
    if (getAgentStatus(agentName) === "thinking" && paneIdleNow) {
      const first = idleWhileThinking.get(channelId);
      if (first === undefined) {
        idleWhileThinking.set(channelId, Date.now());
      } else if (Date.now() - first > IDLE_THINKING_GRACE_MS) {
        idleWhileThinking.delete(channelId);
        console.log(`🧭 thinking 对账: ${agentName} 事件态 thinking 但 pane 已空闲 ${Math.round((Date.now() - first) / 1000)}s,强制收敛为 done`);
        emitEvent({ agent: agentName, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "reconcile" } });
      }
    } else {
      idleWhileThinking.delete(channelId);
    }
  } catch { /* 对账失败不影响弹窗检测 */ }

  // v2.7+ agents 视图自动逃逸（特征界面刚被 Esc 掉 → 本轮不再做弹窗检测）
  if (await maybeEscapeAgentsView(agentName, channelId, pane, discord)) return;

  // v2.15.2+「Switch model?」弹窗：钉定家族的迟到确认框代按,其余通知用户拍板
  if (await maybeConfirmSwitchModel(agentName, channelId, pane, allowedUserIds, discord)) return;

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

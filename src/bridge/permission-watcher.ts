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
  tmuxSendEscape,
  isRewindDialog,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  detectDevChannelsModal,
} from "../lib/tmux-helper.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";
import { parseAuqPane } from "../lib/auq-pane.js";
import {
  auqStates,
  clearAuqState,
  registerAuqState,
  postAskUserQuestionMessage,
  type AuqQuestion,
} from "./ask-user-question.js";
import { emitEvent } from "./event-bus.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_INTERVAL_MS = 8_000;

// v2.7+ agents 视图自动逃逸的通知去重（channelId → 上次通知时间戳）
const agentsViewNotifiedAt = new Map<string, number>();
const AGENTS_VIEW_NOTIFY_COOLDOWN_MS = 10 * 60_000;

// v2.19.0 Rewind 卡窗兜底（agentName → 首次看见 Rewind 的时刻 / 上次通知时刻）
const rewindSince = new Map<string, number>();
const rewindNotifiedAt = new Map<string, number>();
/** 停在 Rewind 超过这个时长才动手——真人开着读检查点列表，几分钟足够了 */
const REWIND_STUCK_MS = 3 * 60_000;
const REWIND_NOTIFY_COOLDOWN_MS = 30 * 60_000;

/**
 * v2.19.0 兜底：窗口长期停在 CC 的 Rewind 检查点对话框 → 单发护栏 Esc 救回。
 *
 * 2026-08-11 事故的止损层。真实病根是「350ms 内连发两个 Esc = CC 的 Rewind
 * 手势」（已在 tmuxSendEscape 里封死），但被模态挡住的窗口收不了消息、pane
 * 永远非 idle，**外部完全看不出来**——用户只看到「好多 agent 卡住了」，
 * wedge-watcher 要 30 分钟才吭声。这里 3 分钟就拉回并留痕。
 *
 * 只有「持续 3 分钟没变」才动手：人真的在读这个对话框时不会被抢，抢了也顶多
 * 少一次 rewind 操作，而卡死一个 agent 是几小时的静默损失。
 */
async function maybeRecoverRewind(
  agentName: string,
  channelId: string,
  pane: string,
  discord: Client,
): Promise<boolean> {
  if (!isRewindDialog(pane)) {
    rewindSince.delete(agentName);
    return false;
  }
  const first = rewindSince.get(agentName);
  if (!first) {
    rewindSince.set(agentName, Date.now());
    return true; // 本轮先记账，别的检测也没意义（模态挡着）
  }
  if (Date.now() - first < REWIND_STUCK_MS) return true;

  const target = windowTarget(agentName);
  console.log(`⏪ ${agentName} 卡在 Rewind 对话框 ${Math.round((Date.now() - first) / 1000)}s,发 Esc 救回`);
  await tmuxSendEscape(target).catch(() => {});
  rewindSince.delete(agentName);

  const last = rewindNotifiedAt.get(channelId) ?? 0;
  if (Date.now() - last > REWIND_NOTIFY_COOLDOWN_MS) {
    rewindNotifiedAt.set(channelId, Date.now());
    try {
      const ch = (await discord.channels.fetch(channelId)) as TextChannel;
      await ch.send(
        `⏪ **${agentName}** 的窗口停在 Claude Code 的 Rewind 检查点对话框里（被模态挡住时收不到消息），已自动 Esc 拉回。` +
          `连按两次 Esc 会触发这个手势——如果是你自己打开在看的，重开一次即可。`,
      );
    } catch { /* non-critical */ }
  }
  return true;
}

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
  await tmuxSendEscape(target);
  await Bun.sleep(1_000);
  const after = await tmuxCapture(target, 30);
  if (after.includes("describe a task for a new session")) {
    // 护栏会把这一发垫到距上一发 ≥1200ms —— 连发两个 Esc 正是 CC 的 Rewind 手势
    await tmuxSendEscape(target);
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

/** v2.21.1+ copy-mode 卡死追踪:channelId → 首见时刻。持续超过阈值才 cancel,
 *  给 owner 在裸 tmux 里正当选文本留余地(agent pane 正常运行不该停留 copy-mode)。 */
const copyModeFirstSeen = new Map<string, number>();
const COPY_MODE_STUCK_MS = 3 * 60 * 1000;
const IDLE_THINKING_GRACE_MS = 120_000;

// ── v2.17.2 AskUserQuestion pane 侧检测 ──────────────────────────────
// CC 2.1.x 把 AUQ tool_use 攒到作答后才落盘,jsonl 检测结构性迟到(2026-08-07
// migration 事故:弹窗挂 4 分钟,web/Discord 全程无卡片,状态还被 thinking 对账
// 收敛成 done —— 用户视角就是"卡死")。及时通路在这里:8s 轮询里认弹窗本体。
/** channelId → 连续未见弹窗的 tick 数(AuqState 在而弹窗消失 = 人工作答,2 次清卡) */
const auqPaneMiss = new Map<string, number>();
/** channelId → 已发过降级通知的多问弹窗 key(问题文本),防每 tick 刷屏 */
const auqMultiNotified = new Map<string, string>();

/**
 * pane 上的 AUQ 弹窗生命周期管理。返回 true = 弹窗在场(本轮 checkAgent 到此为止,
 * 权限弹窗检测不用再跑 —— 同屏不可能两种弹窗)。
 *
 * - 无 AuqState + 弹窗出现:单问题(含单问题多选,选项全可见)→ 注册状态 + emit
 *   question 事件(web ask 卡) + Discord select 卡。多问题表单 pane 只能看到当前
 *   section,凑不齐完整数据 → 降级为通知(assistant_text 事件 + Discord 截图),
 *   引导用户开远程终端作答。
 * - 有 AuqState + 弹窗消失:连续 2 tick(~16s)未见 → 人工在终端作答/取消了,
 *   清态 + question_cleared(stale),把 web/Discord 的卡收掉。
 */
async function maybeHandleAuq(
  agentName: string,
  channelId: string,
  pane: string,
  allowedUserIds: string[],
  discord: Client
): Promise<boolean> {
  const parse = parseAuqPane(pane);
  const existing = auqStates.get(channelId);

  if (existing) {
    if (parse) {
      auqPaneMiss.delete(channelId);
      return true; // 弹窗还挂着,等用户在卡片上作答
    }
    const miss = (auqPaneMiss.get(channelId) || 0) + 1;
    if (miss >= 2) {
      auqPaneMiss.delete(channelId);
      clearAuqState(channelId);
      console.log(`🎛 AUQ 弹窗已在 TUI 侧消失(人工作答/取消)→ 清卡 agent=${agentName}`);
      emitEvent({ agent: agentName, chatId: channelId, type: "question_cleared", data: { reason: "stale", via: "pane" } });
    } else {
      auqPaneMiss.set(channelId, miss);
    }
    return false;
  }

  auqPaneMiss.delete(channelId);
  if (!parse) {
    auqMultiNotified.delete(channelId);
    return false;
  }

  // 多问题表单:pane 只见当前 section,完整卡片凑不出来 → 降级通知(每弹窗一次)
  if (parse.sections.length > 1) {
    if (auqMultiNotified.get(channelId) === parse.question) return true;
    auqMultiNotified.set(channelId, parse.question);
    const text = `🎛 agent 弹了一个多问选择框(${parse.sections.join(" / ")}),交互卡暂不支持多问表单 —— 请开远程终端(🖥️)或 tmux 作答`;
    emitEvent({ agent: agentName, chatId: channelId, type: "assistant_text", data: { text } });
    console.log(`🎛 pane 检测到多问 AUQ (${parse.sections.length} 问) for ${agentName} → 降级通知`);
    recordMetric("auq_detect", { channelId, meta: { source: "pane", form: "multi-question" } });
    if (!channelId.startsWith("local-")) {
      try {
        const pngPath = await tmuxScreenshot(agentName);
        const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
        const ch = (await discord.channels.fetch(channelId)) as TextChannel;
        await ch.send({
          content: [`🎛 **${agentName}** 弹了一个多问选择框(${parse.sections.join(" / ")}),请在终端作答`, mention].filter(Boolean).join("\n"),
          files: pngPath ? [{ attachment: pngPath }] : undefined,
        });
      } catch { /* Discord 面失败不影响 web 通知 */ }
    }
    return true;
  }

  // 单问题(单选或多选):选项全可见,完整交互卡流程
  const q: AuqQuestion = {
    question: parse.question,
    header: (parse.sections[0] || "").slice(0, 12),
    options: parse.options.map((o) => ({
      label: o.label.slice(0, 100),
      description: o.description ? o.description.slice(0, 100) : undefined,
    })),
    multiSelect: parse.multiSelect,
  };
  const tmuxTarget = windowTarget(agentName);
  registerAuqState(channelId, tmuxTarget, [q], "pane");
  if (!channelId.startsWith("local-")) {
    postAskUserQuestionMessage(discord, channelId, tmuxTarget, [q]).catch((e) =>
      console.error("AUQ pane 检测 Discord post 失败:", e)
    );
  }
  console.log(`🎛 pane 检测到 AskUserQuestion (1 问, ${parse.form}${parse.multiSelect ? ", 多选" : ""}) for ${agentName}`);
  recordMetric("auq_detect", { channelId, meta: { source: "pane", form: parse.form } });
  emitEvent({ agent: agentName, chatId: channelId, type: "question", data: { questions: [q] } });
  return true;
}

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
    const { getAgentStatus, emitEvent, isChannelExternallyBusy } = await import("./event-bus.js");
    const { hasActiveBgActivities } = await import("./bg-activity-watcher.js");
    const paneIdleNow = /❯/.test(pane) && !/esc to interrupt/i.test(pane);
    // v2.21.1+ 「pane idle 但 agent 逻辑在忙」豁免(owner 2026-09-02:「每次起
    // background task 都触发[提前完成],不只 codex」)。对账本意是抓「状态卡
    // thinking 但真闲」的死状态,但 agent 大量异步等待时 pane idle 是常态,不是
    // 卡死。两类可靠的「真在忙」信号并集豁免:
    //   ① externallyBusy:bridge 经手的长 MCP 调用(ask_codex,实测 303s)
    //   ② hasActiveBgActivities:bg-activity-watcher 追踪的后台 shell task /
    //      subagent 仍在写输出(3min 不增长才判 finished)
    // 命中任一 → 不收敛 done + 重置计时器,真闲下来后重新累计 120s 才判。
    // 残留边界:静默 bg task(3min 不写输出)会被判 finished,之后若仍 idle 可能
    // 误判——那种少见,且此刻 agent 确实无可观测活动。
    const logicallyBusy = isChannelExternallyBusy(channelId) || hasActiveBgActivities(agentName);
    if (getAgentStatus(agentName) === "thinking" && paneIdleNow && !logicallyBusy) {
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

  // v2.19.0 Rewind 卡窗兜底（模态挡着，其余检测本轮都没意义）
  if (await maybeRecoverRewind(agentName, channelId, pane, discord)) return;

  // v2.7+ agents 视图自动逃逸（特征界面刚被 Esc 掉 → 本轮不再做弹窗检测）
  if (await maybeEscapeAgentsView(agentName, channelId, pane, discord)) return;

  // v2.21.1+ copy-mode 卡死自愈(peer 2026-08-30):pane 进 copy-mode 后所有
  // send-keys 被 tmux 吃掉、注入静默失效,且 capture-pane 显示的是翻屏视图,
  // 下面所有弹窗检测都会被带偏。agent 的 pane 没有人类正当停留 copy-mode 的
  // 场景(iTerm -CC 原生滚动不进 copy-mode;web 终端滚轮是已知触发源)——
  // 持续 3 分钟就 cancel。短暂停留放过:可能是 owner 恰好在裸 tmux 里选文本。
  try {
    const inMode = (await tmuxRaw(["display-message", "-p", "-t", windowTarget(agentName), "#{pane_in_mode}"])).trim();
    if (inMode !== "" && inMode !== "0") {
      const first = copyModeFirstSeen.get(channelId);
      if (first === undefined) {
        copyModeFirstSeen.set(channelId, Date.now());
      } else if (Date.now() - first > COPY_MODE_STUCK_MS) {
        copyModeFirstSeen.delete(channelId);
        console.log(`⌨️ ${agentName} 卡在 copy-mode ${Math.round((Date.now() - first) / 1000)}s,自动 cancel(期间所有注入都被吞)`);
        await tmuxRaw(["send-keys", "-t", windowTarget(agentName), "-X", "cancel"]).catch(() => {});
      }
      return; // copy-mode 下 pane 内容是翻屏视图,本轮其余检测无意义
    }
    copyModeFirstSeen.delete(channelId);
  } catch { /* 探测失败不挡后续检测 */ }

  // v2.21.1+ dev-channels 确认框兜底(peer 2026-08-30):这个框是我们自己拼进启动
  // 命令的 flag 引出来的,理应自己按掉。启动就绪轮询窗口内会被代按;但轮询超时
  // 放弃后才起来的实例(死锁强杀后自愈、人肉 send-keys 重启…)没人管,agent 会
  // 永远停在框上。文案精确匹配 + 默认高亮即是正确项,直接 Enter 无误伤面。
  if (detectDevChannelsModal(pane)) {
    console.log(`🔓 ${agentName} 停在 dev-channels 确认框(启动轮询窗口外),自动 Enter 通过`);
    await tmuxRaw(["send-keys", "-t", windowTarget(agentName), "Enter"]).catch(() => {});
    return;
  }

  // v2.15.2+「Switch model?」弹窗：钉定家族的迟到确认框代按,其余通知用户拍板
  if (await maybeConfirmSwitchModel(agentName, channelId, pane, allowedUserIds, discord)) return;

  // v2.17.2+ AskUserQuestion pane 侧检测(CC 2.1.x jsonl 迟落盘,唯一及时通路)
  if (await maybeHandleAuq(agentName, channelId, pane, allowedUserIds, discord)) return;

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

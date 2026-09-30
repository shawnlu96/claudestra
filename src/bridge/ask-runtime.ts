/**
 * 运行时卡住整个回合的地方自动建「待你处理」（docs 13 §4.1）：AskUserQuestion、权限弹框、Codex 运行中的弹框。
 * 作答走它们原有的按键端点（POST /agents/:name/answer、Discord 按钮），这里只跟着开 / 结案：
 * - AUQ：订阅 question / question_cleared 事件；从网页 / Discord 提交的记 answered，其余记 cancelled；
 * - 权限 / Codex：permission-watcher 每轮一行 noteRuntimeDialogs；Discord 按钮答了记 answered（discord-interactions 一行），
 *   网页按键端点发完键当场记（api-routes.ts 一行）；其余（终端里答了、回合结束）弹框消失时记 cancelled。
 * 「每个频道每种来源一条开着的」记在内存；每条带指纹（lib/ask-fingerprint.ts，落在 extra.fp）：bridge 重启后同一个 Codex / 权限弹框
 * 沿用原卡、owner 删过的只要弹框一直没消失就不再开（ask-dismiss.ts）；AUQ 只在同一个进程里按身份精确沿用，重启后开新卡。「消失」只认真看过屏幕的一轮（noteAbsent）：没采样、抓屏失败都算不知道，
 * 不撤卡也不记消失；重启前留下、之后再没被看到的，到期由过期清扫收起。
 */
import { t } from "../lib/i18n.js";
import { answerAsk, closeAsk, getAsk, hasAsksTable, listAsks, MASTER_PROJECT, openAsk, patchAsk, type AskSource, type AskVia, type NewAsk } from "../lib/ledger-asks.js";
import { detectCodexRuntimeDialog } from "../lib/runtime-dialogs.js";
import { auqIdentity, codexExpiry, codexQuotaText, priorByFingerprint, reuseOf, runtimeFingerprint, unclearedRuntimeAsks } from "../lib/ask-fingerprint.js";
import { askDb, askDbIfExists, notePresenceFromEvent, parentExtra, publishAsk, registry, taskOf, whoIs } from "./asks.js";
import { subscribeEvents } from "./event-bus.js";

type RuntimeSource = Exclude<AskSource, "reply">;

interface Held {
  /** askId；"" = 正在建；"~<id>" = 同指纹删过 / 额度卡到期、弹框还在，不开 */
  id: string;
  fp: string;
}
/** 每个频道每种来源同时只有一个弹框、一条开着的 */
const runtimeOpen = new Map<string, Held>();
/** 这次运行里确认过「屏上没有」、库里也对过账的：之后每轮的「没有」不再查库 */
const clearChecked = new Set<string>();
const rtKey = (source: AskSource, channelId: string) => `${source}:${channelId}`;
/** 上一轮看到的权限弹框描述（按频道）：同一个弹框每 8 秒扫到一次，只有变了才开 / 结 */
const permSeen = new Map<string, string>();

/** 单测：清掉内存表（模拟 bridge 重启） */
export function resetRuntimeAsksForTest(): void {
  runtimeOpen.clear();
  clearChecked.clear();
  permSeen.clear();
}

interface AuqPicked {
  questions: { question?: string; header?: string; options: { label?: string }[] }[];
  selections: number[][];
}

/**
 * AUQ 提交后记账（网页按键端点、Discord 提交各一行，在广播 question_cleared 之前）：所选项换成人话写进 decision——
 * 一问的就是选项文字，多问的每问一段「问题：选项」；凭据只进 ask 的答案，不进广播
 */
export function settleAuq(channelId: string, via: AskVia, s: AuqPicked, who: { principal: string; device?: string }): void {
  const labels = s.questions.map((q, i) => {
    const picked = (s.selections[i] ?? []).map((oi) => q.options[oi]?.label ?? `?${oi}`).join("、");
    return s.questions.length > 1 && picked ? `${q.header || q.question || `Q${i + 1}`}：${picked}` : picked;
  });
  settleRuntimeAsk("auq", channelId, via, labels, who);
}

/** 权限弹框卡片上的三个选项：id 就是 POST /agents/:name/answer {kind:"permission", action} 的 action */
const PERMISSION_ASK_OPTIONS = [{ type: "buttons", buttons: [
  { id: "allow", label: t("允许", "Allow"), style: "success" },
  { id: "allow_session", label: t("允许 + 本会话不再问", "Allow for this session"), style: "primary" },
  { id: "deny", label: t("拒绝", "Deny"), style: "danger" },
] }];

/** 网页按键端点只知道 action：记账时换成卡片上的那句人话（和 Discord 按钮记的一样是标签，不是英文 id） */
export const permissionLabel = (action: string): string => PERMISSION_ASK_OPTIONS[0].buttons.find((b) => b.id === action)?.label ?? action;

interface RuntimeAskInput {
  source: RuntimeSource;
  channelId: string;
  agentName: string;
  kind: NewAsk["kind"];
  title: string;
  context: string;
  options: unknown[];
  /** Codex 额度用完：正文换成几点恢复，原文只留在 extra.raw（指纹仍按原文算） */
  quota?: true;
  /** ACP 宿主的卡（bridge/acp-link.ts）：网页按 extra.acp 出按钮，点了走 POST /agents/:name/answer {kind:"acp"} */
  acp?: true;
  /** 卡的代际（ACP 的权限 / 额度卡，按钮 id 里也带着）：进指纹——题面相同的新请求是另一张卡，不沿用旧卡和它的按钮 */
  instance?: string;
  /** ACP 回合失败（不是额度 / 登录）：落在 extra.failure，调度器按它认出是哪类失败（scheduler-auto-ports.ts codexFailure） */
  failure?: "error";
}

export async function openRuntimeAsk(r: RuntimeAskInput): Promise<void> {
  const key = rtKey(r.source, r.channelId);
  // AUQ 按下标作答：问题 / 选项 / 描述有一处不同就是另一个弹框，换卡（tests/ask-dismiss.test.ts）
  const fp = runtimeFingerprint(r.source, r.agentName, r.title, r.source === "auq" ? auqIdentity(r.options) : r.instance ? `${r.context}\n#${r.instance}` : r.context);
  const held = runtimeOpen.get(key);
  if (held?.fp === fp) return;
  if (held) settleRuntimeAsk(r.source, r.channelId); // 同一频道换成了另一个弹框：上一个结掉（记消失）再看这个
  clearChecked.delete(key);
  const slot: Held = { id: "", fp };
  runtimeOpen.set(key, slot);
  try {
    // 跨重启认领、删过压住只给 Codex / 权限卡（owner 要的是额度卡别反复冒）；AUQ 重启后一律开新卡，旧的由 supersede / noteAbsent 撤
    const prior = r.source === "auq" ? null : priorByFingerprint(askDb(), r.source, r.channelId, fp);
    const reuse = reuseOf(prior);
    supersede(r.source, r.channelId, reuse === "adopt" ? prior!.id : "");
    if (reuse !== "new") return void runtimeOpen.set(key, { id: reuse === "adopt" ? prior!.id : `~${prior!.id}`, fp });
    const who = (await whoIs(r.channelId)) ?? { name: r.agentName, project: MASTER_PROJECT, channelId: r.channelId };
    // 卡住的是整个回合；有下游挂在它名下（registry parent）就算急
    const urgent = (await registry()).some((x) => x.parent === who.name && x.status === "active");
    const now = Date.now();
    const expiresAt = r.source === "codex" ? codexExpiry(r.context, now) : undefined;
    const a = openAsk(askDb(), {
      project: who.project, taskId: taskOf(who.name), fromAgent: who.name, fromChannelId: r.channelId, source: r.source, kind: r.kind, blocking: true,
      urgency: urgent ? "urgent" : "normal", title: r.title, context: r.quota ? codexQuotaText(expiresAt, now) : r.context, options: r.options, allowText: false,
      chatId: r.channelId, expiresAt, extra: {
        ...parentExtra(who).extra, fp, ...(r.quota ? { quota: true, raw: r.context } : {}), ...(r.acp ? { acp: true } : {}), ...(r.failure ? { failure: r.failure } : {}),
      },
    }, now);
    publishAsk(a);
    // 建的途中弹框已经没了、或换成了另一个（占位被 settle 拿走）：立刻结案，别留一条永远开着的
    if (runtimeOpen.get(key) !== slot) {
      const c = closeAsk(askDb(), a.id, "cancelled", t("弹框已关闭", "dialog closed"), Date.now(), { clearedAt: Date.now() });
      if (c) publishAsk(c);
      return;
    }
    runtimeOpen.set(key, { id: a.id, fp });
  } catch (e) {
    if (runtimeOpen.get(key) === slot) runtimeOpen.delete(key);
    console.error(`⚠️ 运行时弹框建 ask 失败: ${(e as Error).message}`);
  }
}

/**
 * 弹框没了 / 答了：带 answeredVia 的记 answered（label = 选的是哪个，who = 作答的凭据 / Discord 用户，取不到记 unknown——
 * 按键端点只查 scope，guest、部分 scope 的设备也能答，不能一律记成 owner），其余（终端里答了、取消、回合结束）记 cancelled
 */
export function settleRuntimeAsk(source: RuntimeSource, channelId: string, answeredVia?: AskVia, label?: string | string[], who?: { principal?: string; device?: string }): void {
  const key = rtKey(source, channelId);
  const held = runtimeOpen.get(key);
  if (held === undefined) return;
  runtimeOpen.delete(key);
  if (!held.id) return;
  const id = held.id.replace(/^~/, "");
  try {
    const db = askDb();
    const a = held.id.startsWith("~") ? null : answeredVia
      ? answerAsk(db, id, { choices: [], labels: [label ?? []].flat().filter(Boolean), text: "", principal: who?.principal || "unknown", device: who?.device, via: answeredVia, at: Date.now() })
      : closeAsk(db, id, "cancelled", t("弹框已关闭", "dialog closed"));
    if (a) publishAsk(a);
  } catch (e) {
    // 已被卡片端点先记成 answered，或者到点过期了、owner 删了：这一笔就不用再记
    console.log(`ask ${id} 结案跳过（已结案或已过期）: ${(e as Error).message}`);
  }
  markCleared(id);
}

/**
 * 弹框从屏幕上消失了：记在这条上，同一个弹框以后再出现就是新的一次（删过的、到期的也会重新开）。
 * 不动 updatedAt：这不算一次改动，否则「最近处理过」里的旧卡会跳到最前
 */
function markCleared(id: string): void {
  try {
    const db = askDb();
    const a = getAsk(db, id);
    if (a) patchAsk(db, id, { extra: { clearedAt: Date.now() } }, a.updatedAt);
  } catch (e) {
    console.error(`⚠️ 记弹框消失失败（${id}，同一个弹框再出现时可能不开卡）: ${(e as Error).message}`);
  }
}

/** 同一频道同一种来源同时只有一个弹框：库里别的还开着的（重启前留下的、换卡前那张）都是上一个的，撤掉 */
function supersede(source: RuntimeSource, channelId: string, keep: string): void {
  const db = askDb();
  for (const a of listAsks(db, { source, states: ["open"] })) {
    if (a.fromChannelId !== channelId || a.id === keep) continue;
    const c = closeAsk(db, a.id, "cancelled", t("换成了另一个弹框", "replaced by another dialog"), Date.now(), { clearedAt: Date.now() });
    if (c) publishAsk(c);
  }
}

/**
 * 这一轮确实看过屏幕、这种弹框不在：内存里记着的照常结；没记着的（重启后还没认回的、删过被压着的）按库对一次账——
 * 开着的撤掉，删过 / 到期的记上消失。不要求内存里先见过：重启后第一眼就是空屏也得记上（tests/ask-dismiss.test.ts）
 */
function noteAbsent(source: RuntimeSource, channelId: string): void {
  const key = rtKey(source, channelId);
  if (runtimeOpen.has(key)) settleRuntimeAsk(source, channelId);
  else if (clearChecked.has(key)) return;
  else {
    try {
      const db = askDbIfExists();
      for (const a of db && hasAsksTable(db) ? unclearedRuntimeAsks(db, source, channelId) : []) {
        const c = a.state === "open" ? closeAsk(db!, a.id, "cancelled", t("弹框已关闭", "dialog closed"), Date.now(), { clearedAt: Date.now() }) : null;
        if (c) publishAsk(c);
        else markCleared(a.id);
      }
    } catch (e) {
      return void console.error(`⚠️ 运行时弹框对账失败（${source} ${channelId}，下一轮再试）: ${(e as Error).message}`);
    }
  }
  clearChecked.add(key);
}

/**
 * permission-watcher 每轮每个 agent 抓屏成功后调一次（一行），是「看过屏幕」的唯一来源：
 * - Codex 运行中的弹框（lib/runtime-dialogs.ts 的规则表）在就开、没了就结；
 * - 权限弹框：desc 变了就开新的（指纹不同，旧的先结），没了（null，含换成 session-idle 那种）就结；
 * - AUQ：走到这里 = maybeHandleAuq 已判屏上没有；内存里跟着的 AUQ 由 question_cleared 结，这里只对重启前留下的账。
 */
export function noteRuntimeDialogs(channelId: string, agentName: string, pane: string, permissionDesc: string | null, runtime?: string): void {
  const d = detectCodexRuntimeDialog(pane, runtime);
  if (d) void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", ...d, options: [] });
  else noteAbsent("codex", channelId);
  if (!runtimeOpen.has(rtKey("auq", channelId))) noteAbsent("auq", channelId);
  if (!permissionDesc) {
    permSeen.delete(channelId);
    return noteAbsent("permission", channelId);
  }
  if (permSeen.get(channelId) === permissionDesc) return;
  permSeen.set(channelId, permissionDesc);
  const title = t(`${agentName} 需要授权`, `${agentName} needs permission`);
  void openRuntimeAsk({ source: "permission", channelId, agentName, kind: "authorize", title, context: permissionDesc, options: PERMISSION_ASK_OPTIONS });
}

/**
 * 网页卡片提交 AUQ 前对一下：卡是不是当前这个弹框的（api-routes 的 answer 端点一行）。卡已结案（被换掉 / 删了）、不是这个频道的、
 * 不是内存里正跟着的那张、身份和当前弹框对不上 = 过期卡，它的下标在当前弹框上是另一回事，拒掉。
 * 不带 askId 的（聊天里的交互卡）不查；和实际画面比对是 T65 的事
 */
export function staleAuqCard(askId: unknown, channelId: string, questions: unknown): boolean {
  if (typeof askId !== "string" || !askId) return false;
  const db = askDbIfExists();
  const a = db && hasAsksTable(db) ? getAsk(db, askId) : null;
  if (!a || a.state !== "open" || a.source !== "auq" || a.fromChannelId !== channelId) return true;
  return runtimeOpen.get(rtKey("auq", channelId))?.id !== askId || auqIdentity(a.options) !== auqIdentity(questions);
}

/** 标题取第一问；多问的标上一共几问（卡片里每问都能答） */
function auqTitle(qs: { question?: string; header?: string }[]): string {
  const q = qs[0];
  const first = (q?.question || q?.header || "AskUserQuestion").slice(0, 32);
  return qs.length > 1 ? t(`${first}（共 ${qs.length} 问）`, `${first} (${qs.length} questions)`) : first;
}

/** bridge 启动：订阅 AUQ 事件（顺带记 owner 在不在）。上次留下的运行时卡不在这里撤：等 watcher 真看过屏幕（noteAbsent） */
export function initRuntimeAsks(): void {
  subscribeEvents({}, (evt) => {
    const data = (evt.data ?? {}) as Record<string, unknown>;
    notePresenceFromEvent(evt.type, data);
    if (evt.type === "question") {
      const qs = ((data.questions as unknown[]) ?? []) as { question?: string; header?: string }[];
      const context = qs.map((q) => q.question ?? "").join("\n").slice(0, 300);
      void openRuntimeAsk({ source: "auq", channelId: evt.chatId, agentName: evt.agent, kind: "decide", title: auqTitle(qs), context, options: qs });
    } else if (evt.type === "question_cleared") {
      // 网页 API 的提交端点在广播前已带凭据记过账（这里再结是空操作）；Discord 带 uid；都没有记 unknown
      const who = { principal: typeof data.uid === "string" ? `discord:${data.uid}` : undefined };
      settleRuntimeAsk("auq", evt.chatId, data.reason === "submit" ? (data.via === "discord" ? "discord" : "interact") : undefined, undefined, who);
    }
  });
}

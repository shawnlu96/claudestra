/**
 * 运行时卡住整个回合的地方自动建「待你处理」（docs 13 §4.1）：AskUserQuestion、权限弹框、Codex 运行中的弹框。
 * 作答走它们原有的按键端点（POST /agents/:name/answer、Discord 按钮），这里只跟着开 / 结案：
 * - AUQ：订阅 question / question_cleared 事件；从网页 / Discord 提交的记 answered，其余记 cancelled；
 * - 权限 / Codex：permission-watcher 每轮一行 noteRuntimeDialogs；Discord 按钮答了记 answered（discord-interactions 一行），
 *   网页按键端点发完键当场记（api-routes.ts 一行）；其余（终端里答了、回合结束）弹框消失时记 cancelled。
 * 「每个频道每种来源一条开着的」记在内存；每条带指纹（lib/ask-fingerprint.ts，落在 extra.fp）：bridge 重启后同一个弹框沿用原卡、
 * owner 删过的（ask-dismiss.ts）只要弹框一直没消失就不再开；启动宽限 RESTART_GRACE_MS 之后还没被认回去的才撤（弹框已经不在了）。
 */
import { t } from "../lib/i18n.js";
import { answerAsk, closeAsk, hasAsksTable, isRuntimeAsk, listAsks, MASTER_PROJECT, openAsk, patchAsk, type AskSource, type AskVia, type NewAsk } from "../lib/ledger-asks.js";
import { detectCodexRuntimeDialog } from "../lib/runtime-dialogs.js";
import { codexExpiry, codexQuotaText, priorByFingerprint, reuseOf, runtimeFingerprint } from "../lib/ask-fingerprint.js";
import { askDb, askDbIfExists, notePresenceFromEvent, parentExtra, publishAsk, registry, taskOf, whoIs } from "./asks.js";
import { subscribeEvents } from "./event-bus.js";

type RuntimeSource = Exclude<AskSource, "reply">;

/** 每个频道每种来源同时只有一条开着的；值是 askId（"" = 正在建，"~<id>" = 同指纹删过、弹框还在，不开） */
const runtimeOpen = new Map<string, string>();
const rtKey = (source: AskSource, channelId: string) => `${source}:${channelId}`;
/** 上一轮看到的权限弹框描述（按频道）：同一个弹框每 8 秒扫到一次，只有变了才开 / 结 */
const permSeen = new Map<string, string>();

/** 单测：清掉内存表（模拟 bridge 重启） */
export function resetRuntimeAsksForTest(): void {
  runtimeOpen.clear();
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
  /** 同一频道换了一个新弹框：先把旧的结案再开新的 */
  replace?: boolean;
  /** Codex 额度用完：正文换成几点恢复，原文只留在 extra.raw（指纹仍按原文算） */
  quota?: true;
}

export async function openRuntimeAsk(r: RuntimeAskInput): Promise<void> {
  const key = rtKey(r.source, r.channelId);
  if (r.replace) settleRuntimeAsk(r.source, r.channelId);
  if (runtimeOpen.has(key)) return;
  const fp = runtimeFingerprint(r.source, r.agentName, r.title, r.context);
  runtimeOpen.set(key, "");
  try {
    const prior = priorByFingerprint(askDb(), r.source, r.channelId, fp);
    const reuse = reuseOf(prior);
    if (reuse !== "new") return void runtimeOpen.set(key, reuse === "adopt" ? prior!.id : `~${prior!.id}`);
    const who = (await whoIs(r.channelId)) ?? { name: r.agentName, project: MASTER_PROJECT, channelId: r.channelId };
    // 卡住的是整个回合；有下游挂在它名下（registry parent）就算急
    const urgent = (await registry()).some((x) => x.parent === who.name && x.status === "active");
    const now = Date.now();
    const expiresAt = r.source === "codex" ? codexExpiry(r.context, now) : undefined;
    const a = openAsk(askDb(), {
      project: who.project, taskId: taskOf(who.name), fromAgent: who.name, fromChannelId: r.channelId, source: r.source, kind: r.kind, blocking: true,
      urgency: urgent ? "urgent" : "normal", title: r.title, context: r.quota ? codexQuotaText(expiresAt, now) : r.context, options: r.options, allowText: false,
      chatId: r.channelId, expiresAt, extra: { ...parentExtra(who).extra, fp, ...(r.quota ? { quota: true, raw: r.context } : {}) },
    }, now);
    publishAsk(a);
    // 建的途中弹框已经没了（settle 先到、删了占位）：立刻结案，别留一条永远开着的
    if (runtimeOpen.get(key) !== "") {
      const c = closeAsk(askDb(), a.id, "cancelled", t("弹框已关闭", "dialog closed"), Date.now(), { clearedAt: Date.now() });
      if (c) publishAsk(c);
      return;
    }
    runtimeOpen.set(key, a.id);
  } catch (e) {
    runtimeOpen.delete(key);
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
  if (!held) return;
  const id = held.replace(/^~/, "");
  try {
    const db = askDb();
    const a = held.startsWith("~") ? null : answeredVia
      ? answerAsk(db, id, { choices: [], labels: [label ?? []].flat().filter(Boolean), text: "", principal: who?.principal || "unknown", device: who?.device, via: answeredVia, at: Date.now() })
      : closeAsk(db, id, "cancelled", t("弹框已关闭", "dialog closed"));
    if (a) publishAsk(a);
  } catch (e) {
    // 已被卡片端点先记成 answered，或者到点过期了、owner 删了：这一笔就不用再记
    console.log(`ask ${id} 结案跳过（已结案或已过期）: ${(e as Error).message}`);
  }
  markCleared(id);
}

/** 弹框从屏幕上消失了：记在这条上，同一个弹框以后再出现就是新的一次（删过的、到期的也会重新开） */
function markCleared(id: string): void {
  try {
    patchAsk(askDb(), id, { extra: { clearedAt: Date.now() } });
  } catch (e) {
    console.error(`⚠️ 记弹框消失失败（${id}，同一个弹框再出现时可能不开卡）: ${(e as Error).message}`);
  }
}

/**
 * permission-watcher 每轮每个 agent 调一次（一行）：
 * - Codex 运行中的弹框（lib/runtime-dialogs.ts 的规则表）在就开、没了就结；
 * - 权限弹框：desc 变了就开新的（先结旧的），没了（null，含换成 session-idle 那种）就结。
 */
export function noteRuntimeDialogs(channelId: string, agentName: string, pane: string, permissionDesc: string | null, runtime?: string): void {
  const d = detectCodexRuntimeDialog(pane, runtime);
  if (d) void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", ...d, options: [] });
  else settleRuntimeAsk("codex", channelId);
  if (permSeen.get(channelId) === (permissionDesc ?? undefined)) return;
  if (!permissionDesc) {
    permSeen.delete(channelId);
    return settleRuntimeAsk("permission", channelId);
  }
  permSeen.set(channelId, permissionDesc);
  const title = t(`${agentName} 需要授权`, `${agentName} needs permission`);
  void openRuntimeAsk({ source: "permission", channelId, agentName, kind: "authorize", title, context: permissionDesc, options: PERMISSION_ASK_OPTIONS, replace: true });
}

/** 重启后等这么久（permission-watcher 8 秒一轮，给足三轮）再撤没被认回去的 */
export const RESTART_GRACE_MS = 30_000;

/**
 * 上次 bridge 留下、还开着的运行时 ask：弹框还在的，watcher / AUQ 事件按指纹认回去（openRuntimeAsk 的 adopt）；
 * 宽限过后还没被认回去的 = 弹框已经不在了，撤掉。只撤运行时的：agent 的 reply、人 / 系统发起的重启后照样能答
 */
export function cancelUnadoptedRuntimeAsks(): number {
  const db = askDbIfExists();
  if (!db || !hasAsksTable(db)) return 0;
  const held = new Set([...runtimeOpen.values()].map((v) => v.replace(/^~/, "")));
  const stale = listAsks(db, { states: ["open"] }).filter((a) => isRuntimeAsk(a) && !held.has(a.id));
  for (const a of stale) {
    const c = closeAsk(db, a.id, "cancelled", t("bridge 重启后弹框已不在", "dialog gone after bridge restart"), Date.now(), { clearedAt: Date.now() });
    if (c) publishAsk(c);
  }
  return stale.length;
}

/** 标题取第一问；多问的标上一共几问（卡片里每问都能答） */
function auqTitle(qs: { question?: string; header?: string }[]): string {
  const q = qs[0];
  const first = (q?.question || q?.header || "AskUserQuestion").slice(0, 32);
  return qs.length > 1 ? t(`${first}（共 ${qs.length} 问）`, `${first} (${qs.length} questions)`) : first;
}

/** bridge 启动：订阅 AUQ 事件（顺带记 owner 在不在），宽限过后撤掉上次留下、没被认回去的 */
export function initRuntimeAsks(): void {
  setTimeout(() => {
    try {
      const n = cancelUnadoptedRuntimeAsks();
      if (n) console.log(`🧹 撤掉上次 bridge 留下、弹框已不在的运行时「待你处理」${n} 条`);
    } catch (e) {
      console.error(`⚠️ 清理上次留下的运行时 ask 失败（到期会自己过期）: ${(e as Error).message}`);
    }
  }, RESTART_GRACE_MS).unref?.();
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

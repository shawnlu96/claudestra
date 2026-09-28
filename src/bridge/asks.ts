/**
 * 「待你处理」在 bridge 里的接线（docs 13 §4.3 §4.6）：带选项的 reply 自动建 ask；owner 作答后生成答复消息投回发起方；
 * 每分钟扫过期；AUQ / 权限弹框这类运行时卡住的地方建镜像 ask（source ≠ reply，作答走它们原有的按键端点，这里只跟着结案）。
 * 答复与过期通知一律 intent=response / notification + waitForIdle：目标主回合在忙就押到 Stop 后再投，不抢占。
 * 库的读写在 lib/ledger-asks.ts；各入口（网页卡片、聊天里的按钮、Discord）在 ask-entry.ts 与 local-api/asks.ts。
 */
import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { draftFromReply, type WireMatch } from "../lib/ask-options.js";
import { t } from "../lib/i18n.js";
import { answerAsk, closeAsk, dueAsks, listAsks, MASTER_PROJECT, openAsk, patchAsk, type Ask, type AskSource, type AskVia, type NewAsk } from "../lib/ledger-asks.js";
import { activeTasksByAgent } from "../lib/ledger-read.js";
import { LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import { OwnerPresence } from "../lib/owner-presence.js";
import { detectCodexRuntimeDialog } from "../lib/runtime-dialogs.js";
import { readPrincipals } from "../lib/principals.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { emitEvent, subscribeEvents } from "./event-bus.js";
import { ledgerDb } from "./ledger-feed.js";
import { ownerChatIds } from "./push/dispatcher.js";
import { newMessageId, newThreadId, parseChatId, type Delivery, type Endpoint, type Envelope } from "./router.js";

export interface AsksDeps {
  clients: Map<string, { ws: ServerWebSocket<unknown>; cwd?: string }>;
  deliver: (env: Envelope) => Promise<Delivery>;
  /** 目标不在线 / 投递出错：进押后队列（落盘，连上后的扫描会投） */
  hold: (env: Envelope) => void;
  controlChannelId: string;
  /** 网页作答后把 Discord 原消息改成「已处理」（ask-entry.ts）；Web-only 模式没有 */
  editDiscord?: (a: Ask, label: string) => Promise<void>;
}

let deps: AsksDeps | null = null;
let dbPath = LEDGER_PATH;
let readRegistry: () => Promise<RegistryAgent[]> = () => readRegistryAgents();
let ownerChats = async () => ownerChatIds(await readPrincipals());
const listeners = new Set<(a: Ask) => void>();

/** owner 在不在（lib/owner-presence.ts）：推送规则用；网页心跳、owner 发消息、作答都会碰它 */
export const ownerPresence = new OwnerPresence();

/** bridge 对台账的唯一写连接（只写 asks 与 ask 事件，见 lib/ledger-asks.ts 顶部）；库不存在时会建出来 */
export function askDb(): Database {
  return openLedger(dbPath);
}

/** 读：优先只读连接；库还没有或还是 v1（没有 asks 表）→ null，调用方按「没有 ask」处理 */
const readDb = (): Database | null => (dbPath === LEDGER_PATH ? ledgerDb() : askDb());

export function askReadDb(): Database | null {
  const db = readDb();
  return db && db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asks'").get() ? db : null;
}

/** 单测：换库路径、依赖、registry、owner 的网页身份；传 undefined 还原 */
export function setAsksForTest(t: { path: string; deps?: AsksDeps; registry?: RegistryAgent[]; ownerChats?: string[] } | undefined): void {
  dbPath = t?.path ?? LEDGER_PATH;
  deps = t?.deps ?? null;
  readRegistry = t?.registry ? async () => t.registry! : () => readRegistryAgents();
  ownerChats = t?.ownerChats ? async () => new Set(t.ownerChats) : async () => ownerChatIds(await readPrincipals());
  runtimeOpen.clear();
}

/** ask 状态变了：发 SSE（网页重拉），再通知推送等订阅者 */
export function publishAsk(a: Ask): void {
  emitEvent({ agent: a.fromAgent, chatId: a.chatId || a.fromChannelId, type: "ask", data: { project: a.project, askId: a.id, state: a.state } }, { transient: true });
  for (const l of listeners) {
    try {
      l(a);
    } catch (e) {
      console.error(`⚠️ ask 订阅者出错（不影响 ask 本身）: ${(e as Error).message}`);
    }
  }
}

/** 订阅 ask 变化（push/dispatcher 的 onAsk 接这里）；返回退订 */
export function onAsk(l: (a: Ask) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ── 身份：发起方由连接的频道推导，不信 reply 参数 ──

interface Who {
  name: string;
  project: string;
  channelId: string;
}

async function whoIs(channelId: string): Promise<Who | null> {
  if (deps && channelId === deps.controlChannelId) return { name: "master", project: MASTER_PROJECT, channelId };
  const r = (await readRegistry()).find((a) => a.channelId === channelId);
  return r ? { name: r.name, project: r.projectId || MASTER_PROJECT, channelId } : null;
}

function taskOf(name: string): string | null {
  try {
    const db = readDb();
    return db ? (activeTasksByAgent(db).get(name.replace(/^agent-/, ""))?.id ?? null) : null;
  } catch (e) {
    console.error(`⚠️ 建 ask 时读台账任务失败（ask 先不挂任务）: ${(e as Error).message}`);
    return null;
  }
}

/** 发给 owner 的才建 ask：Discord 频道（只有 ALLOWED_USER_IDS 能在里面点），或 owner 本人的网页身份；peer / 其它 token 的对话不算 */
async function toOwner(chatId: string): Promise<boolean> {
  const p = parseChatId(chatId);
  if (p.transport === "discord") return /^\d+$/.test(p.id);
  if (p.transport !== "api") return false;
  return (await ownerChats()).has(chatId);
}

// ── reply → ask ──

async function openAskForReply(env: Envelope, chatId: string, fromChannelId: string): Promise<Ask | null> {
  const draft = draftFromReply(env.content, env.meta.components);
  if (!draft || !(await toOwner(chatId))) return null;
  const who = await whoIs(fromChannelId);
  if (!who) return null;
  const a = openAsk(askDb(), {
    project: who.project, taskId: taskOf(who.name), fromAgent: who.name, fromChannelId, source: "reply", kind: "decide", blocking: null,
    title: draft.title, context: draft.context, body: env.content, options: draft.options, kindHint: draft.kindHint, chatId, threadId: env.meta.threadId,
  });
  publishAsk(a);
  return a;
}

/**
 * agent 的 reply 出站（bridge.ts 的 ws reply 处理只调这一个）：带选项、发给 owner 的先建 ask，askId 进 env.meta 随出站事件带给网页；
 * 投递成功补记 Discord 消息 id，失败把 ask 撤掉。建 ask 出错不挡回复本身。
 */
export async function deliverReplyWithAsk(env: Envelope, chatId: string, fromChannelId: string, send: (e: Envelope) => Promise<Delivery>): Promise<Delivery> {
  let a: Ask | null = null;
  try {
    a = await openAskForReply(env, chatId, fromChannelId);
  } catch (e) {
    console.error(`⚠️ reply 自动建 ask 失败（回复照发）: ${(e as Error).message}`);
  }
  if (a) env.meta.askId = a.id;
  const d = await send(env);
  if (!a) return d;
  try {
    if (d.outcome.kind === "sent") patchAsk(askDb(), a.id, { discordMessageIds: d.outcome.discordMessageIds ?? [] });
    else {
      const c = closeAsk(askDb(), a.id, "cancelled", "reply 没发出去");
      if (c) publishAsk(c);
    }
  } catch (e) {
    console.error(`⚠️ 补记 ask ${a.id} 的投递结果失败: ${(e as Error).message}`);
  }
  return d;
}

// ── 作答 → 答复消息 ──

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/** 答复正文：第一行说明这是哪条 ask 的答复，接着是原样的 wire 行（agent 按 [button:id] 分支的老习惯不变），最后是 owner 的补充 */
export function answerContent(a: Ask, picks: WireMatch[], text: string): string {
  const head = t(`[✅ owner 回复了你 ${hhmm(a.createdAt)} 的「待你处理」（${a.id}）：${a.title}`, `[✅ owner answered your ${hhmm(a.createdAt)} ask (${a.id}): ${a.title}`);
  const chose = picks.length ? t(`。选择：${picks.map((p) => p.label).join("；")}]`, `. Chose: ${picks.map((p) => p.label).join("; ")}]`) : "]";
  return [head + chose, ...picks.map((p) => p.wire), ...(text ? [t(`补充：「${text}」`, `Note: "${text}"`)] : [])].join("\n");
}

/** 发起方还在就投它；被 kill 了改投它的派发者（registry parent），派发者也不在就投大总管 */
async function answerTarget(a: Ask): Promise<{ channelId: string; agentName: string; redirected?: string }> {
  const d = deps!;
  if (d.clients.has(a.fromChannelId) || a.fromChannelId === d.controlChannelId) return { channelId: a.fromChannelId, agentName: a.fromAgent };
  const regs = await readRegistry();
  const self = regs.find((r) => r.channelId === a.fromChannelId);
  if (self?.status === "active") return { channelId: a.fromChannelId, agentName: a.fromAgent };
  const parent = self?.parent ? regs.find((r) => r.name === self.parent && r.status === "active" && r.channelId) : undefined;
  if (parent?.channelId) return { channelId: parent.channelId, agentName: parent.name, redirected: parent.name };
  return { channelId: d.controlChannelId, agentName: "master", redirected: "master" };
}

/** bridge 发给 agent 的一封「不抢占」消息：在线就 deliver（忙会被押后），不在线或出错进押后队列 */
async function sendCalm(from: Endpoint, to: { channelId: string; agentName: string }, intent: Envelope["intent"], content: string, askId: string): Promise<string> {
  const d = deps!;
  const live = d.clients.get(to.channelId);
  const env: Envelope = {
    from,
    to: { kind: "local", agentName: to.agentName, channelId: to.channelId, ws: live?.ws as ServerWebSocket<unknown>, cwd: live?.cwd },
    intent,
    content,
    meta: { messageId: newMessageId("ask"), triggerKind: "ask_answer", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true, askId, skipInterAgentWatchdog: true },
  };
  if (live) {
    const r = await d.deliver(env);
    if (r.outcome.kind === "sent") return env.meta.messageId;
  }
  d.hold(env);
  return env.meta.messageId;
}

export interface AnswerInput {
  ask: Ask;
  picks: WireMatch[];
  text: string;
  /** 已验证的 owner：网页的 api 身份，或 Discord 的 ALLOWED_USER_IDS 用户 */
  from: Endpoint;
  principal: string;
  device?: string;
  via: AskVia;
}

/** 作答（事务里写 answer + decision 事件）→ 投答复。已结案 / 过期抛 LedgerError("conflict")，调用方回「已处理」 */
export async function commitAnswer(i: AnswerInput): Promise<Ask> {
  if (!deps) throw new Error("asks 未初始化");
  const at = Date.now();
  const a = answerAsk(askDb(), i.ask.id, { choices: i.picks.map((p) => p.wire), text: i.text, principal: i.principal, device: i.device, via: i.via, at });
  ownerPresence.touch();
  publishAsk(a);
  const to = await answerTarget(a);
  const outbox = await sendCalm(i.from, to, "response", answerContent(a, i.picks, i.text), a.id);
  patchAsk(askDb(), a.id, { outboxMessageId: outbox, ...(to.redirected ? { extra: { redirectedTo: to.redirected } } : {}) });
  if (to.redirected) console.log(`↪ ask ${a.id} 的发起方 ${a.fromAgent} 不在了，答复改投 ${to.redirected}`);
  if (i.via !== "discord" && a.discordMessageIds.length && deps.editDiscord) {
    void deps.editDiscord(a, i.picks.map((p) => p.label).join("、") || i.text).catch((e) => console.error(`⚠️ 改 Discord 原消息为已处理失败: ${(e as Error).message}`));
  }
  return a;
}

// ── 过期 ──

/** 到期的一律 expired；reply 类通知发起方「没人批，按未批准处理」（没人点 ≠ 同意），运行时弹框类只结案 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const due = dueAsks(askDb(), now);
  for (const a0 of due) {
    const a = closeAsk(askDb(), a0.id, "expired", "", now);
    if (!a) continue;
    publishAsk(a);
    if (a.source !== "reply" || !deps) continue;
    const text = t(
      `[⌛ 你 ${hhmm(a.createdAt)} 发的「待你处理」（${a.id}）：${a.title} —— 到期没人处理，按未批准处理，不要当成同意。还需要就重新问。]`,
      `[⌛ Your ${hhmm(a.createdAt)} ask (${a.id}): ${a.title} expired unanswered — treat it as NOT approved. Ask again if still needed.]`,
    );
    await sendCalm({ kind: "bridge", label: "ask-expire" }, await answerTarget(a), "notification", text, a.id);
  }
  return due.length;
}

// ── 运行时卡住：AUQ / 权限弹框 / Codex 弹框 ──

/** 每个频道每种来源同时只有一条开着的；值是 askId（进程内，bridge 重启后靠过期兜底） */
const runtimeOpen = new Map<string, string>();
const rtKey = (source: AskSource, channelId: string) => `${source}:${channelId}`;

/** 权限弹框卡片上的三个选项：id 就是 POST /agents/:name/answer {kind:"permission", action} 的 action */
const PERMISSION_ASK_OPTIONS = [{ type: "buttons", buttons: [
  { id: "allow", label: t("允许", "Allow"), style: "success" },
  { id: "allow_session", label: t("允许 + 本会话不再问", "Allow for this session"), style: "primary" },
  { id: "deny", label: t("拒绝", "Deny"), style: "danger" },
] }];

interface RuntimeAskInput {
  source: Exclude<AskSource, "reply">;
  channelId: string;
  agentName: string;
  kind: NewAsk["kind"];
  title: string;
  context: string;
  options: unknown[];
  /** 同一频道换了一个新弹框：先把旧的结案再开新的 */
  replace?: boolean;
}

export async function openRuntimeAsk(r: RuntimeAskInput): Promise<void> {
  const key = rtKey(r.source, r.channelId);
  if (r.replace) settleRuntimeAsk(r.source, r.channelId);
  if (runtimeOpen.has(key)) return;
  runtimeOpen.set(key, "");
  try {
    const who = (await whoIs(r.channelId)) ?? { name: r.agentName, project: MASTER_PROJECT, channelId: r.channelId };
    // 卡住的是整个回合；有下游挂在它名下（registry parent）就算急
    const urgent = (await readRegistry()).some((x) => x.parent === who.name && x.status === "active");
    const a = openAsk(askDb(), {
      project: who.project, taskId: taskOf(who.name), fromAgent: who.name, fromChannelId: r.channelId, source: r.source, kind: r.kind, blocking: true,
      urgency: urgent ? "urgent" : "normal", title: r.title, context: r.context, options: r.options, allowText: false, chatId: r.channelId,
    });
    publishAsk(a);
    // 建的途中弹框已经没了（settle 先到、删了占位）：立刻结案，别留一条永远开着的
    if (runtimeOpen.get(key) !== "") {
      const c = closeAsk(askDb(), a.id, "cancelled", t("弹框已关闭", "dialog closed"));
      if (c) publishAsk(c);
      return;
    }
    runtimeOpen.set(key, a.id);
  } catch (e) {
    runtimeOpen.delete(key);
    console.error(`⚠️ 运行时弹框建 ask 失败: ${(e as Error).message}`);
  }
}

/** 弹框没了：从我们这边提交的记 answered，其余（终端里答了、取消、回合结束）记 cancelled */
export function settleRuntimeAsk(source: Exclude<AskSource, "reply">, channelId: string, answeredVia?: AskVia): void {
  const key = rtKey(source, channelId);
  const id = runtimeOpen.get(key);
  if (id === undefined) return;
  runtimeOpen.delete(key);
  if (!id) return;
  try {
    const db = askDb();
    const a = answeredVia
      ? answerAsk(db, id, { choices: [], text: "", principal: "owner", via: answeredVia, at: Date.now() })
      : closeAsk(db, id, "cancelled", t("弹框已关闭", "dialog closed"));
    if (a) publishAsk(a);
  } catch (e) {
    console.log(`ask ${id} 结案跳过（多半已过期）: ${(e as Error).message}`);
  }
}

/** permission-watcher 每次弹框变了调一次：是权限弹框就开（换了一个就先结旧的），是别的弹框（session-idle）就把旧的结掉 */
export function notePermissionAsk(channelId: string, agentName: string, desc: string | null): void {
  if (!desc) return settleRuntimeAsk("permission", channelId);
  const title = t(`${agentName} 需要授权`, `${agentName} needs permission`);
  void openRuntimeAsk({ source: "permission", channelId, agentName, kind: "authorize", title, context: desc, options: PERMISSION_ASK_OPTIONS, replace: true });
}

/** permission-watcher 每轮每个 agent 调一次：Codex 运行中的弹框（lib/runtime-dialogs.ts 的规则表）在就开，没了就结 */
export function noteCodexDialog(channelId: string, agentName: string, pane: string): void {
  const d = detectCodexRuntimeDialog(pane);
  if (d) void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", ...d, options: [] });
  else settleRuntimeAsk("codex", channelId);
}

function auqTitle(qs: { question?: string; header?: string }[]): string {
  const q = qs[0];
  return (q?.question || q?.header || "AskUserQuestion").slice(0, 40);
}

export function initAsks(d: AsksDeps): void {
  deps = d;
  subscribeEvents({}, (evt) => {
    const data = (evt.data ?? {}) as Record<string, unknown>;
    // owner 说话了（Discord 里的人类只可能是 ALLOWED_USER_IDS；网页只认 owner 本人的身份）→ 记一次「在」
    if (evt.type === "chat_message" && data.direction === "in" && (data.srcKind === "user" || data.fromId === `api:${OWNER_PRINCIPAL_ID}`)) ownerPresence.touch();
    else if (evt.type === "question") {
      const qs = ((evt.data as { questions?: unknown[] })?.questions ?? []) as { question?: string; header?: string }[];
      const context = qs.map((q) => q.question ?? "").join("\n").slice(0, 300);
      void openRuntimeAsk({ source: "auq", channelId: evt.chatId, agentName: evt.agent, kind: "decide", title: auqTitle(qs), context, options: qs });
    } else if (evt.type === "question_cleared") {
      settleRuntimeAsk("auq", evt.chatId, data.reason === "submit" ? (data.via === "discord" ? "discord" : "interact") : undefined);
    }
  });
  const tick = () => void sweepExpired().catch((e) => console.error(`⚠️ ask 过期扫描失败: ${(e as Error).message}`));
  setInterval(tick, 60_000).unref?.();
}

/** 网页列表：开着的全给，已结案的只给最近 3 天 */
export function listForWeb(project?: string): Ask[] {
  const db = askReadDb();
  return db ? listAsks(db, { project, closedSince: Date.now() - 3 * 24 * 3600_000, limit: 200 }) : [];
}

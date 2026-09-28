/**
 * 「待你处理」在 bridge 里的接线（docs 13 §4.3 §4.6）：带选项的 reply 自动建 ask；owner 作答后生成答复消息投回发起方；每分钟扫过期。
 * 运行时卡住的镜像 ask（AUQ / 权限 / Codex 弹框）在 ask-runtime.ts；各作答入口与权限门在 ask-entry.ts、local-api/asks.ts。
 * 答复与过期通知一律不抢占（intent=response / notification），并打 meta.waitForIdle 标记：「目标主回合在忙就押后、Stop 后再投」
 * 由 T13a 接进 deliverToLocal；在那之前 response 照常直投（本来就不抢占）。库的读写在 lib/ledger-asks.ts。
 */
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { draftFromReply, groupsLeft, type AskRow, type WireMatch } from "../lib/ask-options.js";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import { t } from "../lib/i18n.js";
import { answerAsk, closeAsk, dueAsks, getAsk, hasAsksTable, listAsks, MASTER_PROJECT, openAsk, patchAsk, type Ask, type AskVia } from "../lib/ledger-asks.js";
import { activeTasksByAgent } from "../lib/ledger-read.js";
import { LEDGER_PATH, LedgerError, openLedger } from "../lib/ledger-store.js";
import { OwnerPresence } from "../lib/owner-presence.js";
import { readPrincipals } from "../lib/principals.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { emitEvent } from "./event-bus.js";
import { ledgerDb } from "./ledger-feed.js";
import { ownerChatIds } from "./push/dispatcher.js";
import { newMessageId, newThreadId, parseChatId, type Delivery, type Endpoint, type Envelope, type TriggerKind } from "./router.js";

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

export const asksDeps = (): AsksDeps | null => deps;
export const registry = (): Promise<RegistryAgent[]> => readRegistry();

/** 写连接在事件循环里同步写：等锁上限压到 1 秒（CLI 的写都是毫秒级），宁可这一笔报 busy 也不把 bridge 卡住 5 秒 */
const ASK_BUSY_MS = 1000;
const tuned = new WeakSet<Database>();

/** bridge 对台账的唯一写连接（只写 asks 与 ask 事件，见 lib/ledger-asks.ts 顶部）；库不存在时会建出来，只在真要写 ask 时调 */
export function askDb(): Database {
  const db = openLedger(dbPath);
  if (!tuned.has(db)) {
    db.exec(`PRAGMA busy_timeout = ${ASK_BUSY_MS}`);
    tuned.add(db);
  }
  return db;
}

/** 库已存在才开写连接（过期扫描、启动清理）：没台账的机器别为了扫描建出一个空库 */
export function askDbIfExists(): Database | null {
  return existsSync(dbPath) ? askDb() : null;
}

/** 读：优先只读连接；库还没有或还是 v1（没有 asks 表）→ null，调用方按「没有 ask」处理 */
const readDb = (): Database | null => (dbPath === LEDGER_PATH ? ledgerDb() : askDbIfExists());

export function askReadDb(): Database | null {
  const db = readDb();
  return db && hasAsksTable(db) ? db : null;
}

/** 单测：换库路径、依赖、registry、owner 的网页身份；传 undefined 还原（运行时 ask 的内存表另由 ask-runtime.ts 清） */
export function setAsksForTest(o: { path: string; deps?: AsksDeps; registry?: RegistryAgent[]; ownerChats?: string[] } | undefined): void {
  dbPath = o?.path ?? LEDGER_PATH;
  deps = o?.deps ?? null;
  readRegistry = o?.registry ? async () => o.registry! : () => readRegistryAgents();
  ownerChats = o?.ownerChats ? async () => new Set(o.ownerChats) : async () => ownerChatIds(await readPrincipals());
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

/** owner 说话了（Discord 里的人类只可能是 ALLOWED_USER_IDS；网页只认 owner 本人的身份）→ 记一次「在」 */
export function notePresenceFromEvent(type: string, data: Record<string, unknown>): void {
  if (type === "chat_message" && data.direction === "in" && (data.srcKind === "user" || data.fromId === `api:${OWNER_PRINCIPAL_ID}`)) ownerPresence.touch();
}

// ── 身份：发起方由连接的频道推导，不信 reply 参数 ──

export interface Who {
  name: string;
  project: string;
  channelId: string;
  /**
   * 派发者（registry parent）和它的频道：建 ask 时就记进 extra——kill 会删掉 registry 条目，到答复时再查就查不到了。
   * 改投按频道认人，名字只作显示：派发者改名后名字对不上，旧名又可能被别的 agent 占用
   */
  parent?: string;
  parentChannelId?: string;
}

export async function whoIs(channelId: string): Promise<Who | null> {
  if (deps && channelId === deps.controlChannelId) return { name: "master", project: MASTER_PROJECT, channelId };
  const regs = await readRegistry();
  const r = regs.find((a) => a.channelId === channelId);
  if (!r) return null;
  const parentChannelId = r.parent ? regs.find((a) => a.name === r.parent)?.channelId : undefined;
  return { name: r.name, project: r.projectId || MASTER_PROJECT, channelId, ...(r.parent ? { parent: r.parent } : {}), ...(parentChannelId ? { parentChannelId } : {}) };
}

/** 建 ask 时记下的派发者（见 Who.parent） */
export const parentExtra = (w: Who): { extra?: Record<string, string> } =>
  w.parent ? { extra: { parent: w.parent, ...(w.parentChannelId ? { parentChannelId: w.parentChannelId } : {}) } } : {};

export function taskOf(name: string): string | null {
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
    ...parentExtra(who),
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

interface Target {
  channelId: string;
  agentName: string;
  /** 发起方已不在，改投给了谁 */
  redirected?: string;
}

/**
 * 答复正文：第一行说明这是哪条 ask 的答复（给 agent 看），之后是 owner 原样发的内容——聊天里是那条消息本身（wire 行 + 补充），
 * 卡片 / Discord 是 wire 行 + 文本框里的话。agent 按 [button:id] 分支的老习惯不变；网页回显和历史只去掉第一行，和乐观气泡对得上。
 * 多行 reply 逐行作答时注明「还有 N 项没答」；改投时注明原发起方。
 */
export function answerContent(a: Ask, picks: WireMatch[], text: string, original?: string, to?: Target): string {
  const title = /[。？！?!.]$/.test(a.title) ? a.title : `${a.title}。`;
  const chose = picks.length ? t(`选择：${picks.map((p) => p.label).join("；")}。`, `Chose: ${picks.map((p) => p.label).join("; ")}. `) : "";
  const left = a.source === "reply" ? groupsLeft(a.options as AskRow[], a.answer?.choices ?? []) : 0;
  const more = !left
    ? ""
    : a.state === "open"
      ? t(`这条还有 ${left} 项没答，答了会再发给你。`, `${left} more part(s) still unanswered. `)
      : t(`还有 ${left} 项 owner 没选（从卡片一次提交，没选的就是不选）。`, `${left} part(s) left unpicked (submitted from the card = not chosen). `);
  const whose = to?.redirected ? t(`（原本是 ${a.fromAgent} 问的，它已经不在，改投给你）`, ` (asked by ${a.fromAgent}, who is gone — redirected to you)`) : "";
  const head = t(
    `[✅ owner 回复了${whose ? "" : "你"} ${hhmm(a.createdAt)} 的「待你处理」（${a.id}）${whose}：${title}${chose}${more}下面是 owner 发的原文]`,
    `[✅ owner answered the ${hhmm(a.createdAt)} ask (${a.id})${whose}: ${title} ${chose}${more}Owner's words below]`,
  );
  return [head, original ?? [...picks.map((p) => p.wire), text].filter(Boolean).join("\n")].join("\n");
}

/**
 * 发起方还在就投它；不在了（停了或被 kill）改投它的派发者，派发者也不在就投大总管。派发者优先看 registry（kill / 改名时
 * repointParentRefs 会修正引用）；被 kill 的已经从 registry 删掉了，就按建 ask 时记下的 extra.parentChannelId 找还在的那个频道，
 * 找不到（只记了名字的旧 ask、派发者也没了）落到大总管——不按名字找，同名的可能是后来新建的不相干 agent（设计 §4.6-3）。
 */
async function answerTarget(a: Ask): Promise<Target> {
  const d = deps!;
  if (d.clients.has(a.fromChannelId) || a.fromChannelId === d.controlChannelId) return { channelId: a.fromChannelId, agentName: a.fromAgent };
  const regs = await readRegistry();
  const self = regs.find((r) => r.channelId === a.fromChannelId);
  if (self?.status === "active") return { channelId: a.fromChannelId, agentName: a.fromAgent };
  const snap = typeof a.extra.parentChannelId === "string" ? a.extra.parentChannelId : undefined;
  const parent = self
    ? self.parent ? regs.find((r) => r.name === self.parent && r.status === "active" && r.channelId) : undefined
    : snap ? regs.find((r) => r.channelId === snap && r.status === "active") : undefined;
  if (parent?.channelId) return { channelId: parent.channelId, agentName: parent.name, redirected: parent.name };
  return { channelId: d.controlChannelId, agentName: "master", redirected: "master" };
}

/** bridge 发给 agent 的一封不抢占的消息：在线就 deliver，不在线或出错进押后队列。trigger：owner 的答复是 ask_answer，其余是 bridge_synth */
async function sendCalm(from: Endpoint, to: Target, intent: Envelope["intent"], content: string, askId: string, trigger: TriggerKind): Promise<string> {
  const d = deps!;
  const live = d.clients.get(to.channelId);
  const env: Envelope = {
    from,
    to: { kind: "local", agentName: to.agentName, channelId: to.channelId, ws: live?.ws as ServerWebSocket<unknown>, cwd: live?.cwd },
    intent,
    content,
    meta: { messageId: newMessageId("ask"), triggerKind: trigger, ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true, askId, skipInterAgentWatchdog: true },
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
  /** owner 在聊天里发的那条原文（答复正文原样带上）；卡片 / Discord 没有 */
  original?: string;
  /** 已验证的 owner：网页的 owner 设备凭据，或 Discord 的 ALLOWED_USER_IDS 用户 */
  from: Endpoint;
  principal: string;
  device?: string;
  via: AskVia;
  /** 卡片一次提交：不管多行 reply 还有没有没答的组都结案 */
  final?: boolean;
}

/**
 * 作答（事务里写 answer + decision 事件）→ 投答复。多行 reply 逐行点时每行都投一次，ask 到所有组答完才结案。
 * 已结案 / 这组答过 / 过期抛 LedgerError("conflict")，调用方回「已处理」；刚在这里被判过期的，顺带给发起方补发「按未批准处理」。
 */
export async function commitAnswer(i: AnswerInput): Promise<Ask> {
  if (!deps) throw new Error("asks 未初始化");
  let a: Ask;
  try {
    const labels = i.picks.map((p) => p.label);
    a = answerAsk(askDb(), i.ask.id, { choices: i.picks.map((p) => p.wire), labels, text: i.text, principal: i.principal, device: i.device, via: i.via, at: Date.now(), final: i.final });
  } catch (e) {
    const cur = e instanceof LedgerError ? e.current : undefined;
    const expired = cur?.expiredNow ? getAsk(askDb(), i.ask.id) : null;
    if (expired) await noticeExpired(expired);
    throw e;
  }
  ownerPresence.touch();
  publishAsk(a);
  const to = await answerTarget(a);
  const outbox = await sendCalm(i.from, to, "response", answerContent(a, i.picks, i.text, i.original, to), a.id, "ask_answer");
  patchAsk(askDb(), a.id, { outboxMessageId: outbox, ...(to.redirected ? { extra: { redirectedTo: to.redirected } } : {}) });
  if (to.redirected) console.log(`↪ ask ${a.id} 的发起方 ${a.fromAgent} 不在了，答复改投 ${to.redirected}`);
  if (a.state === "answered" && i.via !== "discord" && a.discordMessageIds.length && deps.editDiscord) {
    void deps.editDiscord(a, (a.answer?.labels ?? []).join("、") || i.text).catch((e) => console.error(`⚠️ 改 Discord 原消息为已处理失败: ${(e as Error).message}`));
  }
  return a;
}

// ── 过期 ──

/**
 * 刚结成 expired 的一条：发 SSE；reply 类再通知发起方「没人批，按未批准处理」（没人点 ≠ 同意；部分答了的说清哪些答了）。
 * 发起方不在了：改投派发者时写明原发起方；连派发者也没有、只能落到大总管的不发（被 kill 的 agent 留下的一堆过期 ask 不该刷大总管）。
 */
async function noticeExpired(a: Ask): Promise<void> {
  publishAsk(a);
  if (a.source !== "reply" || !deps) return;
  const to = await answerTarget(a);
  if (to.redirected === "master") return;
  const got = a.answer?.labels.length ? t(`其中已答：${a.answer.labels.join("；")}；没答的部分`, `Answered so far: ${a.answer.labels.join("; ")}; the rest`) : "";
  const whose = to.redirected ? t(`${a.fromAgent}（已不在，改投给你）`, `${a.fromAgent} (gone — redirected to you)`) : t("你", "Your");
  const text = t(
    `[⌛ ${whose} ${hhmm(a.createdAt)} 发的「待你处理」（${a.id}）：${a.title} —— 到期没人处理。${got}按未批准处理，不要当成同意。还需要就重新问。]`,
    `[⌛ ${whose} ${hhmm(a.createdAt)} ask (${a.id}): ${a.title} expired. ${got} treat as NOT approved. Ask again if still needed.]`,
  );
  await sendCalm({ kind: "bridge", label: "ask-expire" }, to, "notification", text, a.id, "bridge_synth");
}

/** 到期的一律 expired；库还不存在就什么都不做（不建库） */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const db = askDbIfExists();
  if (!db || !hasAsksTable(db)) return 0;
  const due = dueAsks(db, now);
  for (const a0 of due) {
    const a = closeAsk(db, a0.id, "expired", "", now);
    if (a) await noticeExpired(a);
  }
  return due.length;
}

export function initAsks(d: AsksDeps): void {
  deps = d;
  const tick = () => void sweepExpired().catch((e) => console.error(`⚠️ ask 过期扫描失败: ${(e as Error).message}`));
  setInterval(tick, 60_000).unref?.();
}

/** 网页列表：开着的全给，已结案的只给最近 3 天；visible 是调用方的权限过滤（大总管的 ask 要 scope 含 master） */
export function listForWeb(visible: (a: Ask) => boolean, project?: string): Ask[] {
  const db = askReadDb();
  return db ? listAsks(db, { project, closedSince: Date.now() - 3 * 24 * 3600_000, limit: 200 }).filter(visible) : [];
}

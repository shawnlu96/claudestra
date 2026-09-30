/**
 * 「待你处理」在 bridge 里的接线（docs 13 §4.3 §4.6）：owner 作答后生成答复消息投回发起方；人 / 系统发起的 ask（createAsk）作答只记账。
 * reply 建 ask 在 ask-reply.ts，过期在 ask-expire.ts（每分钟扫一次由 ask-entry.ts initAskWiring 起），运行时卡住的镜像 ask（AUQ / 权限 / Codex 弹框）在 ask-runtime.ts；
 * 各作答入口在 ask-entry.ts、local-api/asks.ts，谁能看 / 答在 lib/ask-access.ts。
 * 答复与过期通知一律不抢占（intent=response / notification），并打 meta.waitForIdle 标记：「目标主回合在忙就押后、Stop 后再投」
 * 由 T13a 接进 deliverToLocal；在那之前 response 照常直投（本来就不抢占）。库的读写在 lib/ledger-asks.ts。
 */
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { groupsLeft, type AskRow, type WireMatch } from "../lib/ask-options.js";
import { isOwnerSource } from "../lib/delegate-marker.js";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import { t } from "../lib/i18n.js";
import { answerAsk, hasAsksTable, listAsks, MASTER_PROJECT, openAskFull, patchAsk, reopenAsk, type Ask, type AskAnswer, type AskAtt, type AskVia, type NewAsk } from "../lib/ledger-asks.js";
import { activeTasksByAgent } from "../lib/ledger-read.js";
import { LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { answerEcho } from "../lib/inbound-body.js";
import { OwnerPresence } from "../lib/owner-presence.js";
import { readPrincipals } from "../lib/principals.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { matchStopWord } from "../lib/stop-words.js";
import { emitEvent } from "./event-bus.js";
import { ledgerDb } from "./ledger-feed.js";
import { ownerChatIds } from "./push/dispatcher.js";
import { newMessageId, newThreadId, parseChatId, type Delivery, type Endpoint, type Envelope, type TriggerKind } from "./router.js";
import { turnCuts } from "./turn-cuts.js";

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

/** ask 状态变了：发 SSE（网页重拉；fromAgent / assignee 给 ledger-feed 按 lib/ask-access.ts 过滤），再通知推送等订阅者 */
export function publishAsk(a: Ask): void {
  const data = { project: a.project, askId: a.id, state: a.state, fromAgent: a.fromAgent, assignee: a.assignee };
  emitEvent({ agent: a.fromAgent ?? "", chatId: a.chatId || a.fromChannelId || "", type: "ask", data }, { transient: true });
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
export async function toOwner(chatId: string): Promise<boolean> {
  const p = parseChatId(chatId);
  if (p.transport === "discord") return /^\d+$/.test(p.id);
  if (p.transport !== "api") return false;
  return (await ownerChats()).has(chatId);
}

// ── 作答 → 答复消息 ──

export const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

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
export async function answerTarget(a: Ask): Promise<Target> {
  const d = deps!;
  const from = a.fromChannelId ?? "";
  const name = a.fromAgent ?? "master";
  if (d.clients.has(from) || from === d.controlChannelId) return { channelId: from, agentName: name };
  const regs = await readRegistry();
  const self = regs.find((r) => r.channelId === from);
  if (self?.status === "active") return { channelId: from, agentName: name };
  const snap = typeof a.extra.parentChannelId === "string" ? a.extra.parentChannelId : undefined;
  const parent = self
    ? self.parent ? regs.find((r) => r.name === self.parent && r.status === "active" && r.channelId) : undefined
    : snap ? regs.find((r) => r.channelId === snap && r.status === "active") : undefined;
  if (parent?.channelId) return { channelId: parent.channelId, agentName: parent.name, redirected: parent.name };
  return { channelId: d.controlChannelId, agentName: "master", redirected: "master" };
}

/** 答复的入站事件带的回显：人话 echo 给气泡显示，原文 wire 给网页和乐观气泡对账、回填按钮已答态 */
const echoOf = (askId: string, e: { text: string; wire?: string }) => ({ askId, echo: e.text, ...(e.wire ? { wire: e.wire } : {}) });

/** bridge 发给 agent 的一封不抢占的消息：在线就 deliver，不在线或出错进押后队列。trigger：owner 的答复是 ask_answer，其余是 bridge_synth */
export async function sendCalm(from: Endpoint, to: Target, intent: Envelope["intent"], content: string, askId: string, trigger: TriggerKind): Promise<string> {
  const d = deps!;
  const live = d.clients.get(to.channelId);
  const env: Envelope = {
    from,
    to: { kind: "local", agentName: to.agentName, channelId: to.channelId, ws: live?.ws as ServerWebSocket<unknown>, cwd: live?.cwd },
    intent,
    content,
    meta: { messageId: newMessageId("ask"), triggerKind: trigger, ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true, askId, skipInterAgentWatchdog: true,
      ...(trigger === "ask_answer" ? { askEcho: echoOf(askId, answerEcho(content)) } : {}) },
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
  /** 作答的人：网页的设备凭据（owner 的带 owner 标记；指给自己的 guest 没有），或 Discord 的 ALLOWED_USER_IDS 用户 */
  from: Endpoint;
  principal: string;
  device?: string;
  via: AskVia;
  /** 卡片一次提交：不管多行 reply 还有没有没答的组都结案 */
  final?: boolean;
  /** 附件引用（指派事项「完成」时附的说明图等），原样存进答案 */
  atts?: AskAtt[];
}

/**
 * 作答后要不要回投给某个 agent：只有 agent 发起的才回投；人 / 系统发起的、指派事项只记账（T28 §2.5 第 5、6 行）。
 * 调度服务（fromAgent "scheduler"）不是会话，它从台账读答复；回投会被改投给大总管，变成无人认领的消息
 */
export const answersGoToAgent = (a: Pick<Ask, "fromAgent" | "kind">): boolean => !!a.fromAgent && a.fromAgent !== "scheduler" && a.kind !== "assigned";

/** 指派事项答案落库之后（T28a 注册：通知 PM）。没注册或抛错，答案照样记下 */
let onAssigned: ((ask: Ask, answer: AskAnswer) => void | Promise<void>) | null = null;
export function setOnAssignedAnswer(fn: typeof onAssigned): void {
  onAssigned = fn;
}

/** 作答前被判不算数（T28a 的指派门）：整笔不记；status 原样回给网页（400 缺原因 / 403 不是这个人 / 409 过时 / 503 认不出人），Discord 上悄悄告诉点的人 */
export class AskRejected extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AskRejected";
  }
}

/** 指派事项记答案之前（T28a 注册）：认人、判门，不算数抛 AskRejected；返回和答案同一事务写台账的函数（它抛错连答案一起回滚），不归它管的返回 undefined */
let prepareAssigned: ((ask: Ask, answer: AskAnswer) => Promise<(() => void) | undefined>) | null = null;
export function setPrepareAssigned(fn: typeof prepareAssigned): void {
  prepareAssigned = fn;
}

/**
 * 作答（事务里写 answer + decision 事件）→ 投答复。多行 reply 逐行点时每行都投一次，ask 到所有组答完才结案。
 * 已结案 / 这组答过 / 过期抛 LedgerError("conflict")，调用方回「已处理」；刚在这里被判过期的（current.expiredNow），
 * 由调用方（ask-entry.ts commitNoticing）补发过期通知——过期那套在 ask-expire.ts，这里不反向依赖它。
 */
export async function commitAnswer(i: AnswerInput): Promise<Ask> {
  if (!deps) throw new Error("asks 未初始化");
  const labels = i.picks.map((p) => p.label);
  // 作答的不是 owner 本人（guest）：原话不进台账 decision 的 text（ledger-asks.ts answerAsk）
  const who = { principal: i.principal, device: i.device, ...(isOwnerSource(i.from) ? { owner: true as const } : { external: true }) };
  const base = { choices: i.picks.map((p) => p.wire), labels, text: i.text, ...who, via: i.via, at: Date.now(), final: i.final };
  const answer = i.atts?.length ? { ...base, atts: i.atts } : base;
  const within = i.ask.kind === "assigned" && prepareAssigned ? await prepareAssigned(i.ask, answer) : undefined;
  const a = answerAsk(askDb(), i.ask.id, answer, within);
  // 只有 owner 本人作答才算「在」（Discord 只有 ALLOWED_USER_IDS；网页看 owner 标记）：guest 答指给自己的不算，否则 owner 卡活的 ask 5 分钟内只弹横幅
  if (i.from.kind !== "api" || i.from.owner) ownerPresence.touch();
  publishAsk(a);
  if (!answersGoToAgent(a)) {
    if (a.kind === "assigned" && a.state === "answered" && a.answer) await runAssignedHook(a, a.answer);
    return a;
  }
  const to = await answerTarget(a);
  // owner 答卡片也是开口：解除这个 agent 上的「停」（答复带 waitForIdle，不经抢占那条路）；选的 / 写的是停字就不解除（wf2 classify-merge-9）
  if (isOwnerSource(i.from)) turnCuts.noteHuman(to.channelId, matchStopWord(i.original ?? [...labels, i.text].filter(Boolean).join(" ")).stop);
  const outbox = await sendCalm(i.from, to, "response", answerContent(a, i.picks, i.text, i.original, to), a.id, "ask_answer");
  patchAsk(askDb(), a.id, { outboxMessageId: outbox, ...(to.redirected ? { extra: { redirectedTo: to.redirected } } : {}) });
  if (to.redirected) console.log(`↪ ask ${a.id} 的发起方 ${a.fromAgent} 不在了，答复改投 ${to.redirected}`);
  if (a.state === "answered" && i.via !== "discord" && a.discordMessageIds.length && deps.editDiscord) {
    void deps.editDiscord(a, (a.answer?.labels ?? []).join("、") || i.text).catch((e) => console.error(`⚠️ 改 Discord 原消息为已处理失败: ${(e as Error).message}`));
  }
  return a;
}

async function runAssignedHook(a: Ask, answer: AskAnswer): Promise<void> {
  if (!onAssigned) return console.log(`指派事项 ${a.id} 已作答，没有注册 onAssignedAnswer（只记账）`);
  try {
    await onAssigned(a, answer);
  } catch (e) {
    console.error(`⚠️ onAssignedAnswer 出错（答案已记下）: ${(e as Error).message}`);
  }
}

/**
 * 押着等目标空闲的答复没投出去、收件的 agent 就被 kill 了（bridge.ts 的 kill 清理调）：ask 放回「待你处理」，告诉 owner 再答一次——
 * 再答时 answerTarget 按那时还在的发起方 / 派发者 / 大总管投。只认 owner 的答复（ask_answer），过期通知之类的丢了无妨。
 */
export async function answerDropped(env: Envelope): Promise<void> {
  const id = env.meta.askId;
  if (!id || env.meta.triggerKind !== "ask_answer" || !deps) return;
  const who = env.to.kind === "local" ? (env.to.agentName ?? env.to.channelId) : "?";
  try {
    const a = reopenAsk(askDb(), id, t(`答复没送到：${who} 在送到之前被 kill 了`, `Answer not delivered: ${who} was killed first`));
    if (!a) return;
    publishAsk(a);
    const text = t(
      `[⚠️ 你答的「${a.title}」（${a.id}）没送到：${who} 在答复送到之前被 kill 了。已放回「待你处理」，还要的话在网页上再答一次（会改投给它的派发者或大总管）。]`,
      `[⚠️ Your answer to "${a.title}" (${a.id}) was not delivered: ${who} was killed first. It is back in your asks; answer again on the web if still needed.]`,
    );
    const meta = { messageId: newMessageId("ask"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() };
    await deps.deliver({ from: { kind: "bridge", label: "ask-dropped" }, to: { kind: "user", userId: "", channelId: deps.controlChannelId }, intent: "notification", content: text, meta });
    console.log(`↩ ask ${a.id} 的答复没送到（${who} 被 kill），已放回 open 并通知 owner`);
  } catch (e) {
    console.error(`⚠️ ask ${id} 的答复没送到，放回 open / 通知 owner 失败（ask 停在已答，owner 看不到这次丢失）: ${(e as Error).message}`);
  }
}

// ── 人 / 系统发起的 ask ──

export type CreateAskInput = Omit<NewAsk, "source" | "fromAgent" | "fromChannelId"> & { source: "human" | "system"; createdBy: string };

/**
 * 人 / 系统发起的 ask（chat 审核、409 转人工、指派事项；T28a 复用）：没有发起 agent，作答只记账（指派事项另调 onAssignedAnswer）。
 * 带 dedupKey 撞上已有的就返回那条、不重复发 SSE / 推送
 */
export function createAsk(input: CreateAskInput): Ask {
  return createAskFull(input).ask;
}

/** 同上，另告诉调用方是不是撞上了已有的（POST 接口要据此决定能不能把那条给出去） */
export function createAskFull(input: CreateAskInput): { ask: Ask; existed: boolean } {
  const r = openAskFull(askDb(), input);
  if (!r.existed) publishAsk(r.ask);
  return r;
}

export function initAsks(d: AsksDeps): void {
  deps = d;
}

/** 网页列表：开着的全给，已结案的只给最近 3 天；owner 删掉的（ask-dismiss.ts 的 dismissed / hidden）不给；visible 是调用方的权限过滤（大总管的 ask 要 scope 含 master） */
export function listForWeb(visible: (a: Ask) => boolean, project?: string, assignee?: string | readonly string[]): Ask[] {
  const db = askReadDb();
  return db ? listAsks(db, { project, assignee, closedSince: Date.now() - 3 * 24 * 3600_000, limit: 200 }).filter((a) => !a.extra.hidden && !a.extra.dismissed && visible(a)) : [];
}

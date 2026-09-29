/**
 * 「待你处理」的作答入口（docs 13 §4.4 §4.7）：聊天里的按钮 / 表单同步发送（POST /agents/:name/messages）、Discord 交互、网页卡片。
 * 三条路都先认出这是哪条 ask，再交给 asks.ts 的 commitAnswer——答复是 intent=response，不抢占正在干活的 agent。
 * 权限：谁能看 / 答在 lib/ask-access.ts（列表、SSE、推送同一个判定）——指给自己的 assignee 本人；其余看 = canReadLedger（大总管的另要 scope 含 master），
 * 答 = owner 本人（isOwnerPrincipal；老的「*」集成 Bearer、guest、peer 都不行）。Discord 只有 ALLOWED_USER_IDS 点得到。不能答的凭据发 [button:x] 照旧是普通消息。
 * 已结案的 ask 再点：网页带了 askId 才回 409 code=ask_closed（没带的不猜，照常投）；Discord 按原消息 id 认，悄悄告诉点的人「已处理」。
 */
import { matchWire, splitWire, type AskRow, type WireMatch } from "../lib/ask-options.js";
import { canReadLedger, OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import { t } from "../lib/i18n.js";
import { findAskByDiscordMessage, getAsk, listAsks, type Ask, type AskAtt } from "../lib/ledger-asks.js";
import { LedgerError } from "../lib/ledger-store.js";
import { canAnswerAsk, canSeeAsk } from "../lib/ask-access.js";
import { agentInScope, isOwnerPrincipal, tokenIdOf, type Principal } from "../lib/principals.js";
import { apiJson, forbidden } from "./api-respond.js";
import { initRuntimeAsks } from "./ask-runtime.js";
import { noticeExpired, sweepExpired } from "./ask-expire.js";
import { answersGoToAgent, answerTarget, askDb, askReadDb, commitAnswer, initAsks, type AnswerInput, type AsksDeps } from "./asks.js";
import { initHumanNode } from "./human-node.js";

/** 每一行 wire 都对得上这条 ask 的选项 → 规范化结果；有一行对不上就不算这条的答复 */
export function picksFor(a: Ask, wires: string[]): WireMatch[] | null {
  const out: WireMatch[] = [];
  for (const w of wires) {
    const m = matchWire(a.options as AskRow[], w);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

/**
 * 这些 wire 答的是 agent 的哪条 ask：网页带了 askId 就只认它（已结案也返回，给「已处理」）；
 * 没带就取最新一条开着且对得上的——不拿已结案的去对，否则新按钮撞上旧 ask 的同名 id 会被吞掉。
 */
export function findAskForWires(agent: string, wires: string[], hint?: string | null): { ask: Ask; picks: WireMatch[] } | null {
  if (!wires.length) return null;
  const db = askReadDb();
  if (!db) return null;
  const hinted = hint ? getAsk(db, hint) : null;
  const pool = hinted && hinted.fromAgent === agent ? [hinted] : listAsks(db, { fromAgent: agent, source: "reply", states: ["open"], limit: 100 }).reverse();
  for (const a of pool) {
    const picks = picksFor(a, wires);
    if (picks) return { ask: a, picks };
  }
  return null;
}

/** 授权按参数批：不带 askId 的点击（旧消息里的按钮）不猜是哪一条，否则旧气泡的「批准」会批掉参数已经变了的新一条 */
const BIND_NEEDS_ID = t("这条授权要从「待你处理」卡片或原消息的按钮批（没认出是哪一条）", "Approve this from its card or its own message (couldn't tell which ask)");

/** 已结案那一句（Discord 悄悄话、网页 409 的提示）：人话 + 当时选了什么 */
export function closedWords(a: Pick<Ask, "state" | "answer">): string {
  const picked = a.answer?.labels.join("、");
  if (a.state === "answered") return picked ? t(`已处理：${picked}`, `Already handled: ${picked}`) : t("已处理", "Already handled");
  if (a.state === "expired") return t("已过期，按未批准处理", "Expired — treated as not approved");
  if (a.state === "superseded") return t("已被新版本取代，请答新的那条", "Superseded by a newer version — answer that one");
  return t("已撤销", "Withdrawn");
}

/** 409 的体：code 给程序判，error 是网页提示里直接显示的那句 */
const closedBody = (a: Pick<Ask, "id" | "state" | "answer">) => ({ ok: false, code: "ask_closed", error: closedWords(a), askId: a.id, state: a.state, answer: a.answer });

/** 作答；作答时才发现到点的（current.expiredNow：这一笔已记成 expired），先补发过期通知再照抛 */
async function commitNoticing(i: AnswerInput): Promise<Ask> {
  try {
    return await commitAnswer(i);
  } catch (e) {
    const expired = e instanceof LedgerError && e.current?.expiredNow ? getAsk(askDb(), i.ask.id) : null;
    if (expired) await noticeExpired(expired);
    throw e;
  }
}

/** 冲突（刚被别处答了 / 这一项答过了 / 到点过期）→ 409，其余错误照抛 */
async function commitOr409(run: () => Promise<Ask>, fallback: Ask): Promise<Response> {
  try {
    const a = await run();
    return apiJson(202, { ok: true, accepted: true, askAnswered: true, ask: { id: a.id, state: a.state }, agent: a.fromAgent });
  } catch (e) {
    if (!(e instanceof LedgerError && e.code === "conflict")) throw e;
    const cur = e.current as { state?: Ask["state"]; answer?: Ask["answer"]; dup?: boolean } | undefined;
    if (cur?.dup) return apiJson(409, { ok: false, code: "ask_part_answered", error: t("这一项已经答过了", "This part was already answered"), askId: fallback.id });
    return apiJson(409, closedBody({ id: fallback.id, state: cur?.state ?? "answered", answer: cur?.answer ?? null }));
  }
}

/** 发起方不在了、答复要改投别人（派发者 / 大总管）：改投目标也得在这个凭据的 scope 里，否则 403——不能借改投把话送进 scope 外的 agent */
async function redirectForbidden(p: Principal, a: Ask): Promise<Response | null> {
  if (!answersGoToAgent(a)) return null;
  const to = await answerTarget(a);
  if (!to.redirected || agentInScope(p, to.agentName)) return null;
  return forbidden(t(`${a.fromAgent} 已经不在，答复会改投 ${to.agentName}，这台设备的授权不含它`, `${a.fromAgent} is gone; the answer would go to ${to.agentName}, outside this device's scope`));
}

/** 和 POST /agents/:name/messages 同一个 from：带 owner 标记，owner 答复里的 @ 委托标记才不会被中和（router.ts） */
const apiFrom = (p: Principal) => ({ kind: "api" as const, tokenId: tokenIdOf(p), name: p.name || tokenIdOf(p), ...(isOwnerPrincipal(p) ? { owner: true as const } : {}) });

/**
 * POST /agents/:name/messages 里的一行调用：消息里的 wire 行答的是这个 agent 的某条 ask → 当答复处理，返回响应；
 * 不是（或这个凭据不能答）→ null，调用方照常投递。
 */
export async function answerFromChat(req: { agent: string; text: string; principal: Principal; askId?: string | null }): Promise<Response | null> {
  const p = req.principal;
  if (!isOwnerPrincipal(p) || !canReadLedger(p)) return null;
  const { wires, rest } = splitWire(req.text);
  const hit = findAskForWires(req.agent, wires, req.askId);
  if (!hit || !canAnswerAsk(p, hit.ask)) return null;
  if (hit.ask.state !== "open") return apiJson(409, closedBody(hit.ask));
  if (hit.ask.bind && hit.ask.id !== req.askId) return apiJson(409, { ok: false, code: "ask_id_required", error: BIND_NEEDS_ID, askId: hit.ask.id });
  const blocked = await redirectForbidden(p, hit.ask);
  if (blocked) return blocked;
  return commitOr409(() => commitNoticing({ ask: hit.ask, picks: hit.picks, text: rest, original: req.text, from: apiFrom(p), principal: p.id, device: p.credential, via: "web_chat" }), hit.ask);
}

/**
 * 网页卡片：POST /ledger/:project/asks/:id/answer，body {choices: wire[], text?}。卡片是一次提交：不管多行 reply 还有没有没答的组都结案。
 * 运行时弹框（AUQ / 权限）不走这里：卡片按原有端点（POST /agents/:name/answer）发键，由那个端点当场记是谁、选了什么。
 */
export async function answerFromCard(project: string, id: string, body: { choices?: unknown; text?: unknown; atts?: unknown }, p: Principal): Promise<Response> {
  const db = askReadDb();
  const a = db ? getAsk(db, id) : null;
  if (!a || a.project !== project || !canSeeAsk(p, a)) return apiJson(404, { ok: false, error: `ask "${id}" not found in "${project}"` });
  if (!canAnswerAsk(p, a)) return forbidden("answering requires the owner or the assignee");
  if (a.state !== "open") return apiJson(409, closedBody(a));
  if (isRuntimeAsk(a)) return apiJson(400, { ok: false, error: "runtime dialogs are answered via POST /agents/:name/answer" });
  const wires = Array.isArray(body.choices) ? body.choices.filter((c): c is string => typeof c === "string") : [];
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const picks = picksFor(a, wires);
  if (!picks) return apiJson(400, { ok: false, error: "choice does not match this ask's options" });
  if (!picks.length && !(a.allowText && text)) return apiJson(400, { ok: false, error: "pick an option or write something" });
  const atts = attsOf(body.atts);
  if (atts === null) return apiJson(400, { ok: false, error: "atts must be [{kind, ref, name?, mime?}] (≤ 20)" });
  const blocked = await redirectForbidden(p, a);
  if (blocked) return blocked;
  return commitOr409(() => commitNoticing({ ask: a, picks, text, from: apiFrom(p), principal: p.id, device: p.credential, via: "web_card", final: true, atts }), a);
}

/** 运行时弹框镜像出来的（AUQ / 权限 / Codex）：按键走它们原有的端点，卡片端点不收 */
const isRuntimeAsk = (a: Pick<Ask, "source">) => a.source === "auq" || a.source === "permission" || a.source === "codex";

/** 作答附带的附件引用（T28a 的 talk 附件库）：只做形状校验、原样存；不合格 → null（400） */
function attsOf(raw: unknown): AskAtt[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const ok = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  const out: AskAtt[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || !ok(x.kind, 32) || !ok(x.ref, 512) || (x.name !== undefined && !ok(x.name, 200)) || (x.mime !== undefined && !ok(x.mime, 100))) return null;
    out.push({ kind: x.kind as string, ref: x.ref as string, ...(x.name ? { name: x.name as string } : {}), ...(x.mime ? { mime: x.mime as string } : {}) });
  }
  return out;
}

/** Discord 交互里要用到的那一小撮（不 import discord.js 的类型，单测好造） */
export interface DiscordClick {
  messageId?: string;
  user: { id: string; username: string };
  channelId: string;
  origContent: string;
  /** 把原消息改成「已点击」并去掉按钮 */
  edit: (content: string) => Promise<unknown>;
  /** 只有点的人看得见的一句话 */
  whisper: (content: string) => Promise<unknown>;
  /** 起 typing（agent 收到答复就要干活）；单测不给 */
  typing?: () => void;
}

/**
 * Discord 按钮 / 选单（discord-interactions.ts 两处各一行，排在「agent 在不在线」之前：离线也能答，答复进押后队列 / 改投）。
 * 按原消息 id 找 ask：找不到 → false，照旧投；已结案 → 悄悄告诉点的人；开着 → 作答（不抢占）。
 * 多行 reply 只答了其中一组：原消息不动（别的行还要点），只悄悄说一句已收到；全部答完才把原消息改成已点击、去掉按钮。
 */
export async function answerFromDiscord(c: DiscordClick, wire: string): Promise<boolean> {
  const db = askReadDb();
  const a = db && c.messageId ? findAskByDiscordMessage(db, c.messageId) : null;
  if (!a) return false;
  const picks = picksFor(a, [wire]);
  if (!picks) return false;
  if (a.state !== "open") {
    await c.whisper(closedWords(a));
    return true;
  }
  try {
    const from = { kind: "user" as const, userId: c.user.id, channelId: c.channelId, username: c.user.username };
    const out = await commitNoticing({ ask: a, picks, text: "", from, principal: `discord:${c.user.id}`, via: "discord" });
    c.typing?.();
    if (out.state === "open") await c.whisper(t(`已收到：${picks[0].label}（这条还有别的项没答）`, `Got it: ${picks[0].label} (other parts still open)`));
    else await c.edit(`${c.origContent}\n\n✅ ${t("已点击", "Clicked")}：**${(out.answer?.labels ?? [picks[0].label]).join("、")}**`);
  } catch (e) {
    if (!(e instanceof LedgerError && e.code === "conflict")) throw e;
    await c.whisper((e.current as { dup?: boolean } | undefined)?.dup ? t("这一项已经答过了", "This part was already answered") : closedWords(getAsk(askDb(), a.id) ?? a));
  }
  return true;
}

/** discord.js 按钮 / 选单交互里用到的字段（交互此前已 deferUpdate，所以改原消息用 editReply） */
export interface DiscordInteractionLike {
  message?: { id: string; content?: string } | null;
  user: { id: string; username: string };
  editReply(o: { content: string; components: never[] }): Promise<unknown>;
  followUp(o: { content: string; ephemeral: boolean }): Promise<unknown>;
}

/** discord-interactions.ts 的一行调用：`if ((await answerDiscordInteraction(interaction, channelId, wire, typing)) || !client) return;` */
export function answerDiscordInteraction(i: DiscordInteractionLike, channelId: string, wire: string, typing?: () => void): Promise<boolean> {
  return answerFromDiscord({
    messageId: i.message?.id, user: i.user, channelId, origContent: i.message?.content ?? "", typing,
    edit: (content) => i.editReply({ content, components: [] }),
    whisper: (content) => i.followUp({ content, ephemeral: true }),
  }, wire);
}

/** 选单版（discord-interactions.ts 一行）：多选的值用逗号连成 `[select:id:v1,v2]`，与网页同一个 wire */
export function answerDiscordSelect(i: DiscordInteractionLike & { values: string[] }, channelId: string, id: string, typing?: () => void): Promise<boolean> {
  return answerDiscordInteraction(i, channelId, `[select:${id}:${i.values.join(",")}]`, typing);
}

/** Discord 客户端里改消息用到的那一点（不 import discord.js 的类型） */
interface DiscordLike {
  channels: { fetch(id: string): Promise<unknown> };
}
type EditableChannel = { messages: { fetch(id: string): Promise<{ content: string; components: unknown[]; edit(o: unknown): Promise<unknown> }> } };

/** 网页 / 卡片作答后：把 Discord 原消息里带按钮的那段改成「已处理（网页）」并去掉按钮（编辑不触发推送，不打扰） */
export function discordAskEditor(discord: DiscordLike): (a: Ask, label: string) => Promise<void> {
  return async (a, label) => {
    const ch = (await discord.channels.fetch(a.chatId)) as EditableChannel | null;
    if (!ch?.messages) return;
    for (const id of a.discordMessageIds) {
      const msg = await ch.messages.fetch(id);
      if (!msg.components.length) continue;
      await msg.edit({ content: `${msg.content}\n\n✅ ${t("已处理（网页）", "Handled (web)")}：**${label}**`, components: [] });
    }
  };
}

/** bridge.ts 启动时的一行：接上投递 / 押后队列，Discord 模式下带上「改原消息为已处理」；撤掉上次留下的运行时 ask 并订阅 AUQ 事件；每分钟扫过期 */
export function initAskWiring(d: Omit<AsksDeps, "editDiscord"> & { discord: DiscordLike | null }): void {
  const { discord, ...rest } = d;
  initAsks({ ...rest, editDiscord: discord ? discordAskEditor(discord) : undefined });
  initRuntimeAsks();
  initHumanNode(); // 指给人的任务：进 build / fix 开指派 ask，作答写台账、通知 PM（bridge/human-node.ts）
  const sweep = () => void sweepExpired().catch((e) => console.error(`⚠️ ask 过期扫描失败: ${(e as Error).message}`));
  setInterval(sweep, 60_000).unref?.();
}

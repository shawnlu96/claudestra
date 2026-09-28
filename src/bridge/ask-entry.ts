/**
 * 「待你处理」的作答入口（docs 13 §4.4 §4.7）：聊天里的按钮 / 表单同步发送（POST /agents/:name/messages）、Discord 交互、网页卡片。
 * 三条路都先认出这是哪条 ask，再交给 asks.ts 的 commitAnswer——答复是 intent=response，不抢占正在干活的 agent。
 * 已结案的 ask 再点：网页回 409 ask_closed（前端提示「已处理」），Discord 回一条只有点的人看得见的「已处理」，都不再投给 agent。
 * 只有 canReadLedger 的 owner 凭据（非 peer、全 scope）和 Discord 的 ALLOWED_USER_IDS 能作答；别的 token 发 [button:x] 照旧是普通消息。
 */
import { matchWire, splitWire, type AskRow, type WireMatch } from "../lib/ask-options.js";
import { canReadLedger } from "../lib/devices.js";
import { t } from "../lib/i18n.js";
import { findAskByDiscordMessage, getAsk, listAsks, type Ask } from "../lib/ledger-asks.js";
import { LedgerError } from "../lib/ledger-store.js";
import { tokenIdOf, type Principal } from "../lib/principals.js";
import { apiJson } from "./api-respond.js";
import { askReadDb, commitAnswer, initAsks, type AsksDeps } from "./asks.js";

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

/** 这些 wire 答的是 agent 的哪条 ask：优先网页带来的 askId，否则取最新一条开着且对得上的；都没有再看已结案的（给「已处理」） */
export function findAskForWires(agent: string, wires: string[], hint?: string | null): { ask: Ask; picks: WireMatch[] } | null {
  if (!wires.length) return null;
  const db = askReadDb();
  if (!db) return null;
  const hinted = hint ? getAsk(db, hint) : null;
  const pool = hinted && hinted.fromAgent === agent ? [hinted] : listAsks(db, { fromAgent: agent, source: "reply", limit: 100 });
  const open = pool.filter((a) => a.state === "open").reverse();
  const closed = pool.filter((a) => a.state !== "open");
  for (const a of [...open, ...closed]) {
    const picks = picksFor(a, wires);
    if (picks) return { ask: a, picks };
  }
  return null;
}

const closedBody = (a: Ask) => ({ ok: false, error: "ask_closed", askId: a.id, state: a.state, answer: a.answer });

/** 冲突（刚被别处答了 / 到点过期）→ 409，其余错误照抛 */
async function commitOr409(run: () => Promise<Ask>, fallback: Ask): Promise<Response> {
  try {
    const a = await run();
    return apiJson(202, { ok: true, accepted: true, askAnswered: true, ask: { id: a.id, state: a.state }, agent: a.fromAgent });
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict") return apiJson(409, { ...closedBody(fallback), state: e.current?.state ?? "answered", answer: e.current?.answer ?? null });
    throw e;
  }
}

const apiFrom = (p: Principal) => ({ kind: "api" as const, tokenId: tokenIdOf(p), name: p.name || tokenIdOf(p) });

/**
 * POST /agents/:name/messages 里的一行调用：消息里的 wire 行答的是这个 agent 的某条 ask → 当答复处理，返回响应；
 * 不是 → null，调用方照常投递。
 */
export async function answerFromChat(req: { agent: string; text: string; principal: Principal; askId?: string | null }): Promise<Response | null> {
  if (!canReadLedger(req.principal)) return null;
  const { wires, rest } = splitWire(req.text);
  const hit = findAskForWires(req.agent, wires, req.askId);
  if (!hit) return null;
  if (hit.ask.state !== "open") return apiJson(409, closedBody(hit.ask));
  const p = req.principal;
  return commitOr409(() => commitAnswer({ ask: hit.ask, picks: hit.picks, text: rest, from: apiFrom(p), principal: p.id, device: p.credential, via: "web_chat" }), hit.ask);
}

/** 网页卡片：POST /ledger/:project/asks/:id/answer，body {choices: wire[], text?} */
export async function answerFromCard(project: string, id: string, body: { choices?: unknown; text?: unknown }, p: Principal): Promise<Response> {
  const db = askReadDb();
  const a = db ? getAsk(db, id) : null;
  if (!a || a.project !== project) return apiJson(404, { ok: false, error: `ask "${id}" not found in "${project}"` });
  if (a.source !== "reply") return apiJson(400, { ok: false, error: "runtime dialog: answer via POST /agents/:name/answer" });
  if (a.state !== "open") return apiJson(409, closedBody(a));
  const wires = Array.isArray(body.choices) ? body.choices.filter((c): c is string => typeof c === "string") : [];
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const picks = picksFor(a, wires);
  if (!picks) return apiJson(400, { ok: false, error: "choice does not match this ask's options" });
  if (!picks.length && !(a.allowText && text)) return apiJson(400, { ok: false, error: "pick an option or write something" });
  return commitOr409(() => commitAnswer({ ask: a, picks, text, from: apiFrom(p), principal: p.id, device: p.credential, via: "web_card" }), a);
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
}

/**
 * Discord 按钮 / 选单（discord-interactions.ts 两处各一行）：按原消息 id 找 ask。找不到 → false，照旧投；
 * 已结案 → 悄悄告诉点的人「已处理」；开着 → 作答（不抢占），原消息改成已点击。
 */
export async function answerFromDiscord(c: DiscordClick, wire: string): Promise<boolean> {
  const db = askReadDb();
  const a = db && c.messageId ? findAskByDiscordMessage(db, c.messageId) : null;
  if (!a) return false;
  const picks = picksFor(a, [wire]);
  if (!picks) return false;
  const done = (x: Ask) => t(`已处理：${x.answer?.choices.join(" ") || x.state}`, `Already handled: ${x.answer?.choices.join(" ") || x.state}`);
  if (a.state !== "open") {
    await c.whisper(done(a));
    return true;
  }
  try {
    const from = { kind: "user" as const, userId: c.user.id, channelId: c.channelId, username: c.user.username };
    await commitAnswer({ ask: a, picks, text: "", from, principal: `discord:${c.user.id}`, via: "discord" });
    await c.edit(`${c.origContent}\n\n✅ ${t("已点击", "Clicked")}：**${picks[0].label}**`);
  } catch (e) {
    if (!(e instanceof LedgerError && e.code === "conflict")) throw e;
    await c.whisper(t("这条已经处理过或过期了", "This was already handled or has expired"));
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

/** discord-interactions.ts 的一行调用：`if (!client || (await answerDiscordInteraction(interaction, channelId, wire))) return;` */
export function answerDiscordInteraction(i: DiscordInteractionLike, channelId: string, wire: string): Promise<boolean> {
  return answerFromDiscord({
    messageId: i.message?.id, user: i.user, channelId, origContent: i.message?.content ?? "",
    edit: (content) => i.editReply({ content, components: [] }),
    whisper: (content) => i.followUp({ content, ephemeral: true }),
  }, wire);
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

/** bridge.ts 启动时的一行：接上投递 / 押后队列，Discord 模式下带上「改原消息为已处理」 */
export function initAskWiring(d: Omit<AsksDeps, "editDiscord"> & { discord: DiscordLike | null }): void {
  const { discord, ...rest } = d;
  initAsks({ ...rest, editDiscord: discord ? discordAskEditor(discord) : undefined });
}

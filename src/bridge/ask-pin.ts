/**
 * Discord #control 置顶的「待你处理 · 授权」摘要（docs 13 §4.4，T11b 第 5 条，PM 定：只列授权类）：
 * 每条没结案的授权类 ask 一行；ask 有变化就改这一条（编辑不推送，不打扰），第一次发出来时置顶。
 * 消息 id 记在状态目录的 ask-pin.json；那条被人删了 / 取不到就重发一条再置顶。Web-only 模式（没有 Discord）不起。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { t } from "../lib/i18n.js";
import { hasAsksTable, listAsks, type Ask } from "../lib/ledger-asks.js";
import { statePath } from "../lib/paths.js";
import { askReadDb, hhmm, onAsk } from "./asks.js";

const PIN_FILE = statePath("ask-pin.json");
/** 一次作答 / 取代会连着来几条事件，合成一次改 */
const DEBOUNCE_MS = 3_000;
const MAX_LINES = 15;

interface PinMessage {
  id: string;
  edit(o: { content: string }): Promise<unknown>;
  pin(): Promise<unknown>;
}
interface PinChannel {
  send(o: { content: string }): Promise<PinMessage>;
  messages: { fetch(id: string): Promise<PinMessage> };
}
export interface PinDiscord {
  channels: { fetch(id: string): Promise<unknown> };
}

/** 摘要正文（纯函数，单测直接喂 ask）：没有就写一句「没有」，别让旧摘要挂着过时的内容 */
export function pinText(asks: Pick<Ask, "fromAgent" | "title" | "createdAt" | "taskId">[]): string {
  const head = t(`📌 待你处理 · 授权（${asks.length}）`, `📌 Needs you · authorizations (${asks.length})`);
  if (!asks.length) return `${head}\n${t("现在没有等你批的授权。", "Nothing waiting for your approval.")}`;
  const lines = asks.slice(0, MAX_LINES).map((a) => `• ${a.fromAgent ?? "—"}${a.taskId ? ` · ${a.taskId}` : ""}：${a.title}（${hhmm(a.createdAt)}）`);
  const more = asks.length > MAX_LINES ? [t(`…还有 ${asks.length - MAX_LINES} 条，在网页「待你处理」里看`, `…${asks.length - MAX_LINES} more in the web inbox`)] : [];
  return [head, ...lines, ...more].join("\n");
}

function openAuthorizations(): Ask[] {
  const db = askReadDb();
  return db && hasAsksTable(db) ? listAsks(db, { states: ["open"] }).filter((a) => a.kind === "authorize") : [];
}

function readPinId(channelId: string, file: string): string | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { channelId?: string; messageId?: string };
    return j.channelId === channelId && j.messageId ? j.messageId : null;
  } catch {
    return null; // 还没发过（或文件坏了）：发一条新的
  }
}

/** 改摘要（内容没变不动）；上次那条取不到就重发并置顶。last.text 记着上次写上去的正文 */
export async function refreshAskPin(discord: PinDiscord, channelId: string, last: { text: string }, file = PIN_FILE): Promise<void> {
  const text = pinText(openAuthorizations());
  if (text === last.text) return;
  const ch = (await discord.channels.fetch(channelId)) as PinChannel | null;
  if (!ch?.messages) return;
  const id = readPinId(channelId, file);
  const old = id ? await ch.messages.fetch(id).catch(() => null) : null; // 被删了 / 没权限读：当没有，重发一条
  if (old) await old.edit({ content: text });
  else {
    const m = await ch.send({ content: text });
    await m.pin().catch((e) => console.warn(`📌 待你处理摘要置顶失败（消息已发）: ${(e as Error).message}`));
    writeFileSync(file, JSON.stringify({ channelId, messageId: m.id }));
  }
  last.text = text;
}

/** bridge 启动（ask-entry.ts initAskWiring，有 Discord 时）：先对一次账，之后授权类 ask 有变化就改 */
export function initAskPin(discord: PinDiscord, channelId: string): void {
  const last = { text: "" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => void refreshAskPin(discord, channelId, last).catch((e) => console.error(`⚠️ 待你处理摘要没改成: ${(e as Error).message}`));
  onAsk((a) => {
    if (a.kind !== "authorize") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  run();
}

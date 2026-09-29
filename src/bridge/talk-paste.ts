/**
 * 「粘贴外部文字」（工作台输入框，T50）：人把别处来的一段文字交给当前 agent。这是人与人 / 外部内容进 agent 上下文的第二条路
 * （docs/talk/README.md「封闭清单」）。身份、scope、押后规则都和丢进工作台一样（talk-drop.ts 的 resolveAgent / sendOrHold）；
 * 正文由 bridge 生成（lib/talk-drop-render.ts renderPasteBody），不管谁贴的都按外部文本。不做预览：内容就在这一次请求里，
 * 发出去后工作台里看到的就是 agent 收到的。tests/talk-api.test.ts。
 */
import { randomUUID } from "node:crypto";
import { isOwnerPrincipal, tokenIdOf, type Principal } from "../lib/principals.js";
import { renderPasteBody } from "../lib/talk-drop-render.js";
import { asksDeps } from "./asks.js";
import { newThreadId, type Envelope, type LocalEndpoint } from "./router.js";
import { nameOf, talkPrincipals, type Me } from "./talk.js";
import { resolveAgent, sendOrHold, type DropError } from "./talk-drop.js";

const PASTE_TEXT_MAX = 50_000;
const SOURCE_MAX = 200;

export async function commitPaste(me: Me, principal: Principal, b: Record<string, unknown>): Promise<{ state: "sent" | "held"; messageId: string } | DropError> {
  if (typeof b.text !== "string" || !b.text.trim()) return { status: 400, error: "text required" };
  if (b.text.length > PASTE_TEXT_MAX) return { status: 400, error: `text too long (max ${PASTE_TEXT_MAX} chars)` };
  if (b.source !== undefined && (typeof b.source !== "string" || b.source.length > SOURCE_MAX)) return { status: 400, error: `source must be a string ≤ ${SOURCE_MAX} chars` };
  const agent = await resolveAgent(principal, b.agent);
  if ("status" in agent) return agent;
  const by = nameOf(me.personId, await talkPrincipals());
  const id = randomUUID();
  const now = Date.now();
  const messageId = `paste_${now}_${id.slice(0, 8)}`;
  const env: Envelope = {
    from: { kind: "api", tokenId: tokenIdOf(principal), name: by, ...(isOwnerPrincipal(principal) ? { owner: true as const } : {}) },
    to: { kind: "local", agentName: agent.name, channelId: agent.channelId, ws: asksDeps()?.clients.get(agent.channelId)?.ws as LocalEndpoint["ws"] },
    intent: "notification",
    content: renderPasteBody({ by, source: typeof b.source === "string" ? b.source : undefined, text: b.text, key: id }),
    meta: { messageId, triggerKind: "system", ts: new Date(now).toISOString(), threadId: newThreadId(), skipInterAgentWatchdog: true },
  };
  const state = await sendOrHold(env, agent, "粘贴外部文字");
  console.log(`📋 粘贴外部文字：${me.personId} → ${agent.name}（${b.text.length} 字，${state}）`);
  return { state, messageId };
}

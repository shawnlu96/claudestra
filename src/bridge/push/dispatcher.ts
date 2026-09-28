/**
 * 推送派发器（原 web/lib/push/dispatcher.ts 搬入 bridge，规则原样）：订阅进程内 event-bus 的 chat_message——
 *   · agent 回复 owner 的网页对话（direction out、chatId 是 owner 的 api: 身份、非 notice）→ 未读 +1 + 推送到所有订阅 / 设备；
 *     回 Discord 的不推（Discord 有自己的 @），peer / 其它 token 的对话不推（别人问 agent，owner 手机不该响）；
 *   · 用户在 agent 的 Discord 频道里说话（chatId 纯数字、in、user）→ 他已经看到了回复 → 标已读；
 *   · 任何已读（onAgentRead）→ 非 iOS 订阅收 dismiss（带角标）、原生壳收一条只带 badge 的静默 APNs；iOS 订阅不发 dismiss。
 * 失效订阅 / 设备（gone）随手清理。不再自己开 SSE 连自己，也不需要 3339 端口锁：bridge 只有一个进程。
 * Web Push 的每条 payload 都带本机指纹 fp：托管前端一个 SW 管多台机器，点通知要知道去哪台标已读（web/public/sw.js）。
 */
import type { Database } from "bun:sqlite";
import type { ApnsMessage } from "../../lib/apns.js";
import { OWNER_PRINCIPAL_ID } from "../../lib/devices.js";
import type { PrincipalsFile } from "../../lib/principals.js";
import { deleteApnsDevice, deletePushSubscription, dismissSafe, listApnsDevices, listPushSubscriptions, type PushSubscriptionRow, setPushSubscriptionKey } from "../../lib/push-store.js";
import { markdownToPlain } from "../../lib/plain-text.js";
import { bareAgent, bumpUnread, countsUnread, markAgentRead, onAgentRead, totalUnread, type ReadEvent } from "../../lib/unread-store.js";
import type { PushSender } from "./sender.js";

/** 只看这几个字段；与 event-bus 的 BridgeEvent 结构兼容，不 import 它（派发器不该依赖 bridge 的 hub） */
interface ChatEventLike {
  type: string;
  agent: string;
  chatId: string;
  data: Record<string, unknown>;
}

export interface DispatcherDeps {
  db: Database;
  sender: PushSender;
  /** 这个 chatId 是不是 owner 本人的网页身份（api:owner:self，或旧 web-ui token 的 api:<tokenId>） */
  isOwnerChat: (chatId: string) => boolean;
  /** 本机实例指纹；没有实例密钥时不带（SW 退回「当前机器」） */
  fp?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Dispatcher {
  onEvent(evt: ChatEventLike): Promise<void>;
  /** 不属于任何会话的系统提醒（新设备配对等）：推给 owner 的所有设备，不计未读 */
  notice(n: { title: string; body: string; url?: string }): Promise<void>;
  /** 退订 onAgentRead（测试用） */
  stop(): void;
}

export const OWNER_CHAT_ID = `api:${OWNER_PRINCIPAL_ID}`;
const BODY_MAX = 180;

/** owner 的网页聊天身份：owner:self 一定算；过渡期名为 web-ui 的老 token（旧 Next 前端用的那把）也算 */
export function ownerChatIds(file: PrincipalsFile): Set<string> {
  const ids = new Set([OWNER_CHAT_ID]);
  for (const p of file.principals) {
    if (p.name === "web-ui" && !p.disabled && !p.peer && p.id.startsWith("token:")) ids.add(`api:${p.id.slice("token:".length)}`);
  }
  return ids;
}

/** 通知正文：先去掉 Markdown 与行内按钮等样式（lib/plain-text.ts），再压成一行、最多 180 字 */
export function notificationBody(text: string): string {
  const t = markdownToPlain(text).replace(/\s+/g, " ").trim();
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX)}…` : t;
}

export function createDispatcher(d: DispatcherDeps): Dispatcher {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.log(`🔔 ${m}`));

  async function webPushAll(payload: Record<string, unknown>, filter?: (s: PushSubscriptionRow) => boolean): Promise<void> {
    const subs = listPushSubscriptions(d.db).filter((s) => !filter || filter(s));
    if (!subs.length) return;
    const json = JSON.stringify(d.fp ? { fp: d.fp, ...payload } : payload);
    await Promise.all(subs.map(async (s) => {
      const r = await d.sender.sendWebPush(s, json);
      if (r.ok && r.vapidKey && r.vapidKey !== s.vapidKey) setPushSubscriptionKey(d.db, s, r.vapidKey);
      if (r.gone) {
        deletePushSubscription(d.db, s.endpoint);
        log(`订阅已失效，已清理（${r.status ?? r.error}）`);
      } else if (!r.ok) log(`Web Push 发送失败: ${r.status ?? ""} ${r.error ?? ""}`.trim());
    }));
  }

  async function apnsAll(msg: ApnsMessage): Promise<void> {
    if (!d.sender.config().apns) return;
    const tokens = listApnsDevices(d.db);
    if (!tokens.length) return;
    await Promise.all(tokens.map(async (t) => {
      const r = await d.sender.sendApns(t, msg);
      if (r.gone) {
        deleteApnsDevice(d.db, t);
        log(`APNs token 失效已清理（${r.status} ${r.error ?? ""}）`);
      } else if (!r.ok) log(`APNs 发送失败: ${r.status ?? ""} ${r.error ?? ""}`.trim());
    }));
  }

  /** 已读 → 各端收尾。未读真变了才同步角标（绝大多数打开会话动作本来就没未读，别为它们白发推送） */
  async function onRead(e: ReadEvent): Promise<void> {
    if (!e.hadUnread) return webPushAll({ type: "dismiss", agent: e.agent, ts: e.ts }, dismissSafe);
    const badge = totalUnread(d.db);
    await Promise.all([
      webPushAll({ type: "dismiss", agent: e.agent, ts: e.ts, badge }, dismissSafe),
      // iOS 图标角标只能由推送或 App 自己改：一条只带 badge 的静默 APNs 让图标数回落（不弹通知）
      apnsAll({ silent: true, badge, title: "", body: "", agent: e.agent, url: "/chat", ts: e.ts, tag: `cstra-badge-${e.ts}` }),
    ]);
  }

  const unsubscribe = onAgentRead((e) => void onRead(e).catch((err) => log(`已读同步失败: ${(err as Error).message}`)));

  return {
    async onEvent(evt) {
      if (evt.type !== "chat_message") return;
      const data = evt.data ?? {};
      const chatId = String(evt.chatId ?? "");
      if (data.direction === "in" && data.srcKind === "user" && /^\d+$/.test(chatId)) {
        markAgentRead(d.db, String(evt.agent ?? ""), now());
        return;
      }
      if (data.direction !== "out" || data.notice) return; // 「↪ 已转给 X」只是提示，不推送不计未读（接手方的回复会推）
      if (!d.isOwnerChat(chatId)) return;
      const agent = bareAgent(String(evt.agent ?? ""));
      const body = notificationBody(String(data.text ?? ""));
      if (!agent || !body) return;
      const ts = now();
      // 计数发生在推送之前，与有没有订阅者无关——没装推送也要有未读；badge = 全局未读总数
      const badge = countsUnread(agent) ? bumpUnread(d.db, agent, ts) : totalUnread(d.db);
      const url = `/chat?agent=${encodeURIComponent(agent)}`;
      // 每条推送独立 tag：iOS 对同 tag 通知是静默替换（不横幅不震动），折叠已放弃
      const tag = `cstra-${agent}-${ts}`;
      await Promise.all([
        apnsAll({ title: agent, body, agent, url, ts, tag, badge }),
        webPushAll({ title: agent, body, badge, url, agent, ts, tag }),
      ]);
    },
    async notice(n) {
      const ts = now();
      const msg = { title: notificationBody(n.title), body: notificationBody(n.body), url: n.url ?? "/chat", agent: "", ts, tag: `cstra-notice-${ts}` };
      await Promise.all([apnsAll(msg), webPushAll(msg)]);
    },
    stop: unsubscribe,
  };
}

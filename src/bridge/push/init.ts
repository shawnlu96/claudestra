/**
 * 推送子系统的启动（bridge/http-peer.ts 的 initHttpPeer 调一次）：开状态库、拼出口（中继 / 直发）、配路由、起派发器。
 * 直发后端懒加载：VAPID 密钥优先复用旧 web 的 ~/.claude-orchestrator/web/push-vapid.json（换钥匙 = 既有订阅作废），
 * 没有才在 ~/.claude-orchestrator/push-vapid.json 生成；APNs 读仓库 .env 的 APNS_*（repoEnvVar），p8 默认在
 * ~/.claude-orchestrator/apns/。owner 的聊天身份从 principals.json 取，启动读一次、之后 60 s 一刷（旧 web-ui token 可能被换）。
 * 外部通知渠道（ntfy / Bark / Webhook，bridge/notify/sink.ts）随派发器一起起：点开的地址默认用中继首页。
 */
import { join } from "node:path";
import { ApnsClient, apnsConfigFromEnv } from "../../lib/apns.js";
import { readConfigSync } from "../../lib/config-store.js";
import { repoEnvVar } from "../../lib/env-file.js";
import { instanceKeySync, keyFingerprint } from "../../lib/instance-key.js";
import { STATE_DIR } from "../../lib/paths.js";
import { isSandbox, sandboxDisabledOutsideLab } from "../../lib/sandbox.js";
import type { NotifyType } from "../../lib/notify-channels.js";
import { readNotifyFile } from "../../lib/notify-store.js";
import type { Presence } from "../../lib/owner-presence.js";
import { principalView } from "../../lib/devices.js";
import { readPrincipals, type PrincipalsFile } from "../../lib/principals.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { loadOrCreateVapidKeys, readVapidKeys, webPushSender, type VapidIdentity } from "../../lib/web-push.js";
import { openWebState } from "../../lib/web-state.js";
import { subscribeEvents } from "../event-bus.js";
import type { Delivery, Envelope } from "../router.js";
import { relayClient } from "../relay-link.js";
import { notifyLinkBase } from "../notify/link-base.js";
import { createChannelSink } from "../notify/sink.js";
import { createDispatcher, OWNER_CHAT_ID, ownerChatIds, type Dispatcher, type NoticeOutcome } from "./dispatcher.js";
import { configurePushRoutes } from "./routes.js";
import { createPushSender, type DirectBackends } from "./sender.js";

const PRINCIPALS_REFRESH_MS = 60_000;
let dispatcherRef: Dispatcher | null = null;

/**
 * 系统提醒推给 owner 的所有设备（推送没起来就什么也不做——提醒丢了不影响功能本身）；url = 点通知打开哪里，缺省 /chat；
 * kind = 外部通知渠道按哪一类筛（安全 / 系统 / Talk），缺省 system
 */
export function pushOwnerNotice(title: string, body: string, url?: string, kind?: NotifyType): void {
  dispatcherRef?.notice({ title, body, url, kind }).catch((e) => console.error(`⚠️ 推送：系统提醒没推出去: ${(e as Error).message}`));
}
/**
 * 要知道送没送到的系统提醒（订阅额度快过期：失败的渠道要单独重试）。推送子系统没起来（沙箱 / 启动前）→ null。
 */
export async function pushOwnerNoticeTracked(title: string, body: string, once?: string): Promise<NoticeOutcome | null> {
  // once：账本里这批提醒的 id（quota-reminders.ts）。失败会整条重试，外部渠道按它记已送到，重试不重复推；
  // 不能拿文字当身份：两个窗口先后用满时正文一字不差，第二条合法提醒会被当成重试吞掉
  return dispatcherRef ? dispatcherRef.notice({ title, body, ...(once ? { once } : {}) }) : null;
}
const DEFAULT_VAPID_SUBJECT = "https://github.com/shawnlu96/claudestra";

let started = false;
const NO_DIRECT: DirectBackends = { vapidPublicKey: null, webPush: null, apns: null };

function directBackends(): DirectBackends {
  let vapid: VapidIdentity | null = null;
  try {
    const keys = readVapidKeys(join(STATE_DIR, "web", "push-vapid.json")) ?? loadOrCreateVapidKeys(join(STATE_DIR, "push-vapid.json"));
    vapid = { ...keys, subject: repoEnvVar("PUSH_VAPID_SUBJECT") || DEFAULT_VAPID_SUBJECT };
  } catch (e) {
    console.error(`⚠️ 推送：VAPID 密钥读写失败，直发 Web Push 不可用: ${(e as Error).message}`);
  }
  const apns = apnsConfigFromEnv((k) => repoEnvVar(k), { prefix: "APNS_", keyDir: repoEnvVar("APNS_KEY_DIR") || join(STATE_DIR, "apns") });
  console.log(`🔔 推送直发后端：Web Push ${vapid ? "就绪" : "不可用"}；APNs ${apns.config ? `就绪（${apns.config.env}）` : `未开（${apns.why}）`}`);
  return { vapidPublicKey: vapid?.publicKey ?? null, webPush: vapid ? webPushSender(vapid) : null, apns: apns.config ? new ApnsClient(apns.config) : null };
}

/** deliver：订阅额度提醒的 Discord 渠道要用（quota-service.ts）；额度提醒依赖推送，随推送一起起、沙箱里一起不起 */
export function initPush(deliver?: (env: Envelope) => Promise<Delivery>): void {
  if (started || sandboxDisabledOutsideLab("推送")) return; // 沙箱不发 APNs / Web Push，/api/v1/push 也不挂；lab 模式只经 lab 中继投到假端点
  started = true;
  const db = openWebState();
  let direct: DirectBackends | null = null;
  // lab（沙箱里能走到这里的只有 lab）没有直发后端：web-push / APNs 不走 fetch，出站闸门拦不住，只能不建
  const sender = createPushSender({ relay: relayClient, direct: () => (direct ??= isSandbox() ? NO_DIRECT : directBackends()) });
  let owner = new Set([OWNER_CHAT_ID]);
  let file: PrincipalsFile | null = null;
  const refresh = async () => {
    try {
      file = await readPrincipals();
      owner = ownerChatIds(file);
    } catch (e) {
      console.error(`⚠️ 推送：读 principals.json 失败，沿用上一份 owner 身份表: ${(e as Error).message}`);
    }
  };
  void refresh();
  setInterval(() => void refresh(), PRINCIPALS_REFRESH_MS).unref();
  configurePushRoutes({ db, sender, liveAgents: async () => (await readRegistryAgents()).map((a) => a.name) });
  const key = instanceKeySync();
  // 订阅认人读的是最多 60 s 前的 principals.json
  const resolvePrincipal = (pid: string, cid: string | null) => (file ? principalView(file, pid, cid) : null);
  let isQuietReply: (threadId: unknown) => boolean = () => false;
  const quiet = (threadId: unknown) => isQuietReply(threadId);
  const noContent = () => readConfigSync().pushNoContent === true;
  const fp = key ? keyFingerprint(key.publicKey) : undefined;
  let presence: () => Presence = () => "away";
  // 沙箱（含 lab）不建外部渠道：出站闸门会拦，拦的日志里还带着完整的 webhook 地址
  const channels = isSandbox() ? undefined : createChannelSink({ read: () => readNotifyFile(), noContent, presence: () => presence(), linkBase: notifyLinkBase, ...(fp ? { fp } : {}) });
  const dispatcher = createDispatcher({
    db, sender, isOwnerChat: (id) => owner.has(id), resolvePrincipal, isQuietReply: quiet, noContent, channels, ...(fp ? { fp } : {}),
  });
  dispatcherRef = dispatcher;
  subscribeEvents({}, (evt) => void dispatcher.onEvent(evt).catch((e) => console.error(`⚠️ 推送派发异常（这一条没推出去）: ${(e as Error).message}`)));
  console.log("🔔 推送派发器已启动（进程内订阅 event-bus）");
  // 「待你处理」：动态 import 同额度服务——asks 拖着台账库，推送的单测不该为它付加载代价
  void import("../ask-reply.js").then((m) => (isQuietReply = m.isQuietReply)).catch((e) => console.error(`⚠️ 知会类回复的免推送没接上（照常推）: ${(e as Error).message}`));
  void import("../asks.js")
    .then((m) => {
      presence = () => m.ownerPresence.state();
      m.onAsk((a) => void dispatcher.onAsk(a, m.ownerPresence.state()).catch((e) => console.error(`⚠️ 待你处理没推出去: ${(e as Error).message}`)));
    })
    .catch((e) => console.error(`⚠️ 待你处理的推送没接上: ${(e as Error).message}`));
  if (!deliver) return;
  // 动态 import：额度服务拖着全机用量子进程与 bridge/config，推送的单测不该为它付加载代价
  void import("../quota-service.js")
    .then((q) => q.startQuotaService({ push: pushOwnerNoticeTracked, discord: q.controlChannelSender(deliver) }))
    .catch((e) => console.error(`⚠️ 订阅额度服务没起来（看板退回本机数据）: ${(e as Error).message}`));
}

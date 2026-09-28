/**
 * 推送子系统的启动（bridge/http-peer.ts 的 initHttpPeer 调一次）：开状态库、拼出口（中继 / 直发）、配路由、起派发器。
 * 直发后端懒加载：VAPID 密钥优先复用旧 web 的 ~/.claude-orchestrator/web/push-vapid.json（换钥匙 = 既有订阅作废），
 * 没有才在 ~/.claude-orchestrator/push-vapid.json 生成；APNs 读仓库 .env 的 APNS_*（repoEnvVar），p8 默认在
 * ~/.claude-orchestrator/apns/。owner 的聊天身份从 principals.json 取，启动读一次、之后 60 s 一刷（旧 web-ui token 可能被换）。
 */
import { join } from "node:path";
import { ApnsClient, apnsConfigFromEnv } from "../../lib/apns.js";
import { repoEnvVar } from "../../lib/env-file.js";
import { instanceKeySync, keyFingerprint } from "../../lib/instance-key.js";
import { STATE_DIR } from "../../lib/paths.js";
import { sandboxDisabled } from "../../lib/sandbox.js";
import { readPrincipals } from "../../lib/principals.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { loadOrCreateVapidKeys, readVapidKeys, webPushSender, type VapidIdentity } from "../../lib/web-push.js";
import { openWebState } from "../../lib/web-state.js";
import { subscribeEvents } from "../event-bus.js";
import { relayClient } from "../relay-link.js";
import { createDispatcher, OWNER_CHAT_ID, ownerChatIds, type Dispatcher } from "./dispatcher.js";
import { configurePushRoutes } from "./routes.js";
import { createPushSender, type DirectBackends } from "./sender.js";

const PRINCIPALS_REFRESH_MS = 60_000;
let dispatcherRef: Dispatcher | null = null;

/** 系统提醒推给 owner 的所有设备（推送没起来就什么也不做——提醒丢了不影响功能本身） */
export function pushOwnerNotice(title: string, body: string): void {
  dispatcherRef?.notice({ title, body }).catch((e) => console.error(`⚠️ 推送：系统提醒没推出去: ${(e as Error).message}`));
}
const DEFAULT_VAPID_SUBJECT = "https://github.com/shawnlu96/claudestra";
let started = false;

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

export function initPush(): void {
  if (started || sandboxDisabled("推送")) return; // 沙箱不发 APNs / Web Push；/api/v1/push 路由也就不挂（lib/sandbox.ts）
  started = true;
  const db = openWebState();
  let direct: DirectBackends | null = null;
  const sender = createPushSender({ relay: relayClient, direct: () => (direct ??= directBackends()) });
  let owner = new Set([OWNER_CHAT_ID]);
  const refresh = async () => {
    try {
      owner = ownerChatIds(await readPrincipals());
    } catch (e) {
      console.error(`⚠️ 推送：读 principals.json 失败，沿用上一份 owner 身份表: ${(e as Error).message}`);
    }
  };
  void refresh();
  setInterval(() => void refresh(), PRINCIPALS_REFRESH_MS).unref();
  configurePushRoutes({ db, sender, liveAgents: async () => (await readRegistryAgents()).map((a) => a.name) });
  const key = instanceKeySync();
  const dispatcher = createDispatcher({ db, sender, isOwnerChat: (id) => owner.has(id), ...(key ? { fp: keyFingerprint(key.publicKey) } : {}) });
  dispatcherRef = dispatcher;
  subscribeEvents({}, (evt) => void dispatcher.onEvent(evt).catch((e) => console.error(`⚠️ 推送派发异常（这一条没推出去）: ${(e as Error).message}`)));
  console.log("🔔 推送派发器已启动（进程内订阅 event-bus）");
}

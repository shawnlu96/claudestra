import webpush from "web-push";
import net from "net";
import { getDb } from "@/lib/db";
import { ensureVapid } from "./vapid";

/**
 * Web Push 派发器(owner 2026-07-16「做 pwa 推送」+「谁发的谁回」)。
 *
 * BFF 进程内常驻一条到 Bridge /api/v1/events 的 SSE 订阅(globalThis 单例,
 * instrumentation.ts 启动;断线 5s 退避重连)。推送时机 = 「agent 的 reply 发给
 * api 用户」——chat_message(direction=out) 且 chatId 以 api: 开头,天然就是
 * 「Web 发起的对话得到了回复」;回 Discord 的(chatId 纯数字)不推,Discord 有
 * 自己的 @。人在不在页面上由 Service Worker 侧判断(有聚焦窗口就不弹横幅)。
 *
 * 失效订阅(410 Gone / 404)自动从表里清理。
 */

interface PushRow {
  endpoint: string;
  keys: string;
  ua: string;
}

function listSubs(): PushRow[] {
  try {
    return getDb("settings").prepare("SELECT endpoint, keys, ua FROM push_subscriptions").all() as PushRow[];
  } catch {
    return [];
  }
}

function dropSub(endpoint: string) {
  try {
    getDb("settings").prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  } catch {
    /* ignore */
  }
}

async function sendToAll(
  payload: Record<string, unknown>,
  filter?: (s: PushRow) => boolean,
) {
  const subs = listSubs().filter((s) => !filter || filter(s));
  if (!subs.length) return;
  ensureVapid();
  const json = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: JSON.parse(s.keys) },
          json,
          { TTL: 3600 }
        );
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dropSub(s.endpoint);
        else console.error("[push] 发送失败:", code, (e as Error).message?.slice(0, 120));
      }
    })
  );
}

// ── v2.21.1+ 跨端已读对账(owner 2026-08-30「一处点完,他处取消」)──────────

/** iOS 订阅识别:对「push 到达不展示」有惩罚,dismiss 型静默 push 不能发给它们
 *  (iOS 靠打开 App 时的补清,见 lib/push/client.ts cleanupReadNotifications)。
 *  ua 为空的老订阅按 iOS 保守对待。 */
const IOS_UA_RE = /iPhone|iPad|iPod/i;
const dismissSafe = (s: PushRow) => !!s.ua && !IOS_UA_RE.test(s.ua);

/** 标记 agent 已读(落库)并向非 iOS 订阅广播 dismiss push——SW 收到后静默清掉
 *  该 agent 的存量通知。任何已读信号源(打开会话/点通知/Discord 说话)都走这里。 */
export function markAgentRead(agent: string): void {
  const a = agent.replace(/^agent-/, "");
  const ts = Date.now();
  try {
    getDb("settings")
      .prepare("INSERT INTO push_read (agent, ts) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET ts = excluded.ts")
      .run(a, ts);
  } catch { /* 表缺失等,不影响 dismiss */ }
  void sendToAll({ type: "dismiss", agent: a, ts }, dismissSafe);
}

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://127.0.0.1:3847";
const TOKEN = process.env.CLAUDESTRA_API_TOKEN || "";

/** 事件 → 推送的翻译:reply 给 api 用户 → 通知;Discord 里用户说话 → 已读联动。 */
function maybePush(evt: { type: string; agent: string; chatId: string; data: Record<string, unknown> }) {
  if (evt.type !== "chat_message") return;
  const d = evt.data || {};
  const chatId = String(evt.chatId || "");
  // v2.21.1+ Discord 侧已读代理:用户在某 agent 的 Discord 频道里发了消息
  // (chatId 纯数字 + 入站 + 人类)= 他已经在 Discord 看到了回复 → 联动清掉
  // 各设备上该 agent 的 Web 通知。
  if (d.direction === "in" && d.srcKind === "user" && /^\d+$/.test(chatId)) {
    markAgentRead(String(evt.agent || ""));
    return;
  }
  if (d.direction !== "out") return;
  if (!chatId.startsWith("api:")) return; // 只推 Web 发起的对话
  const agent = String(evt.agent || "").replace(/^agent-/, "");
  const text = String(d.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return;
  void sendToAll({
    title: agent,
    body: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    // 深链:点通知直达该 agent 会话(owner 2026-07-16)
    url: `/chat?agent=${encodeURIComponent(agent)}`,
    agent,
    // v2.21.1+ ts:跨端已读对账的水位——dismiss 只清 ts 早于已读时刻的通知
    ts: Date.now(),
    // v2.17.2:每条推送独立 tag。此前按 agent 折叠(`cstra-${agent}`),但 iOS
    // 对同 tag 通知是「静默替换」——新推送不横幅不震动,用户测试时「啥都没
    // 显示」(2026-08-08 回执实锤:APNs 已投递到设备,展示层被折叠吃掉)。
    // renotify:true 能保折叠+重提醒,但 Safari 不支持——只能放弃折叠,
    // 通知中心逐条积攒(与主流聊天 App 一致)。
    tag: `cstra-${agent}-${Date.now()}`,
  });
}

async function runLoop() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  for (;;) {
    try {
      const res = await fetch(`${BRIDGE}/api/v1/events`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      g.__cstraPushUp = Date.now();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            maybePush(JSON.parse(data));
          } catch {
            /* 心跳/坏帧 */
          }
        }
      }
    } catch {
      /* bridge 重启等,退避后重连 */
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/**
 * 跨进程互斥锁:独占 127.0.0.1 的一个端口,拿到才起推送循环。
 *
 * 进程内的 globalThis 单例挡不住「两个 BFF 进程」——2026-07-16 一次
 * launchctl kickstart 没杀干净 npm→next 的子进程,孤儿 next-server 的
 * 派发器(出站 SSE+出站推送,不需要监听端口)活了 5 天,每条推送必重复
 * (2026-07-21 用户报)。dev(33333) 与正式(3333) 同跑时也是同库双推。
 * 端口锁随进程死亡自动释放;没抢到的每 60s 重试,持锁者退出后自动接管。
 */
const LOCK_PORT = Number(process.env.PUSH_LOCK_PORT || 3339);

function acquireLockThenRun() {
  const srv = net.createServer();
  srv.unref(); // 锁 socket 不阻止进程退出(退出即释放)
  srv.once("error", () => {
    console.log(`[push] 推送锁被其他进程持有(port ${LOCK_PORT}),60s 后重试`);
    setTimeout(acquireLockThenRun, 60_000).unref();
  });
  srv.listen(LOCK_PORT, "127.0.0.1", () => {
    console.log("[push] Web Push 派发器已启动(持有推送锁,订阅 bridge 事件流)");
    void runLoop();
  });
}

/** 启动常驻订阅(幂等——dev HMR/多次 import 只起一条;跨进程由端口锁保证唯一)。 */
export function startPushDispatcher() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__cstraPushLoop) return;
  if (!TOKEN) {
    console.warn("[push] CLAUDESTRA_API_TOKEN 未配置,推送派发器不启动");
    return;
  }
  g.__cstraPushLoop = true;
  acquireLockThenRun();
}

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
}

function listSubs(): PushRow[] {
  try {
    return getDb("settings").prepare("SELECT endpoint, keys FROM push_subscriptions").all() as PushRow[];
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

async function sendToAll(payload: { title: string; body: string; url?: string; tag?: string; agent?: string }) {
  const subs = listSubs();
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

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://127.0.0.1:3847";
const TOKEN = process.env.CLAUDESTRA_API_TOKEN || "";

/** 事件 → 推送的翻译:reply 给 api 用户 → 通知。 */
function maybePush(evt: { type: string; agent: string; chatId: string; data: Record<string, unknown> }) {
  if (evt.type !== "chat_message") return;
  const d = evt.data || {};
  if (d.direction !== "out") return;
  if (!String(evt.chatId || "").startsWith("api:")) return; // 只推 Web 发起的对话
  const agent = String(evt.agent || "").replace(/^agent-/, "");
  const text = String(d.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return;
  void sendToAll({
    title: agent,
    body: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    // 深链:点通知直达该 agent 会话(owner 2026-07-16)
    url: `/chat?agent=${encodeURIComponent(agent)}`,
    agent,
    // 同 agent 的连续回复折叠成一条(系统通知中心不刷屏)
    tag: `cstra-${agent}`,
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

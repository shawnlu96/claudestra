/**
 * v2.22+ 原生壳(Capacitor iOS)推送客户端。壳里没有 Service Worker,Web Push 不可用;
 * 走 Capacitor 的 PushNotifications 插件(经注入的 window.Capacitor.Plugins 调用,
 * 网页不打包 @capacitor/* 依赖)。token 登记到当前机器的 /api/v1/push/apns，由 bridge（或经中继网关）推 APNs。
 */
import { isNativeShell, nativePlugin } from "@/lib/native";
import { apnsRegister } from "@/lib/api/push";
import { t } from "@/lib/i18n";
import { askFromLink } from "@/lib/hash-nav";

type Listener = (ev: unknown) => void;
interface PushPlugin {
  checkPermissions(): Promise<{ receive: "prompt" | "prompt-with-rationale" | "granted" | "denied" }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(name: string, cb: Listener): Promise<unknown> | unknown;
  getDeliveredNotifications(): Promise<{ notifications: Array<{ id: string; data?: Record<string, unknown> }> }>;
  removeDeliveredNotifications(arg: { notifications: Array<{ id: string }> }): Promise<void>;
  removeAllDeliveredNotifications(): Promise<void>;
}

function plugin(): PushPlugin | null {
  if (!isNativeShell()) return null;
  return nativePlugin("PushNotifications") as unknown as PushPlugin | null;
}

export function nativePushAvailable(): boolean {
  return plugin() !== null;
}

export async function nativePushPermission(): Promise<"prompt" | "granted" | "denied" | "unavailable"> {
  const p = plugin();
  if (!p) return "unavailable";
  try {
    const r = await p.checkPermissions();
    return r.receive === "granted" ? "granted" : r.receive === "denied" ? "denied" : "prompt";
  } catch {
    return "unavailable";
  }
}

let listenersBound = false;
let onOpenAgent: ((agent: string) => void) | null = null;
let onOpenAsk: ((ask: string) => void) | null = null;
let onRead: ((agent: string) => Promise<void>) | null = null;

/**
 * 绑定一次性的插件事件(token 登记 / 点通知直达 agent 或「待你处理」那张卡)。App 每次启动调一次。
 * 已读回执由调用方给（chat 的 scoped-requests.markRead：非全权设备不发，接口要全权）——lib 不能反过来 import features。
 */
export function bindNativePushListeners(openAgent: (agent: string) => void, openAsk: (ask: string) => void, read: (agent: string) => Promise<void>): void {
  onOpenAgent = openAgent;
  onOpenAsk = openAsk;
  onRead = read;
  const p = plugin();
  if (!p || listenersBound) return;
  listenersBound = true;
  void p.addListener("registration", (ev) => {
    const token = String((ev as { value?: string })?.value || "");
    if (!token) return;
    const device = `${/iPad/i.test(navigator.userAgent) ? "iPad" : "iPhone"} · ${navigator.platform || "iOS"}`;
    void apnsRegister(token, device).catch(() => {}); // 登记失败下次启动会再 register，不打扰用户
  });
  void p.addListener("registrationError", (ev) => {
    console.warn("[native-push] registration error", ev);
  });
  void p.addListener("pushNotificationActionPerformed", (ev) => {
    const data = ((ev as { notification?: { data?: Record<string, unknown> } })?.notification?.data || {}) as { agent?: string; url?: string };
    // 「待你处理」推送的 url 带 ?ask=：和 Web Push 一样打开抽屉定位那张卡，而不是进发问 agent 的会话
    const ask = askFromLink(data.url);
    if (data.agent) {
      // 点了通知 = 读过了:同 SW 的 notificationclick,通知服务端做跨端已读联动
      void onRead?.(data.agent).catch(() => {}); // 已读回执丢了下一次打开会话会再发
      if (!ask) onOpenAgent?.(data.agent);
    }
    if (ask) onOpenAsk?.(ask);
  });
}

/** 已授权时静默 register(刷新 token,每次启动都做;APNs token 会变)。 */
export async function refreshNativeRegistration(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try {
    if ((await p.checkPermissions()).receive === "granted") await p.register();
  } catch { /* 静默 */ }
}

/** 用户手势里调用:申请权限 → register(token 经 registration 事件登记)。 */
export async function enableNativePush(): Promise<{ ok: boolean; msg: string }> {
  const p = plugin();
  if (!p) return { ok: false, msg: "不在原生壳内" };
  try {
    const r = await p.requestPermissions();
    if (r.receive !== "granted") return { ok: false, msg: "通知权限被拒绝——请到 设置 → Claudestra → 通知 里允许" };
    await p.register();
    return { ok: true, msg: "已开启:agent 回复时会推送到这台设备" };
  } catch (e) {
    return { ok: false, msg: t("开启失败:{msg}", { msg: (e as Error).message }) };
  }
}

/** 打开 App / 回前台时:别处已读的 agent,其存量通知从本机通知中心移除(iOS 半边的跨端已读)。 */
export async function cleanupDeliveredNative(reads: Record<string, number>): Promise<void> {
  const p = plugin();
  if (!p) return;
  try {
    const { notifications } = await p.getDeliveredNotifications();
    const dead = notifications.filter((n) => {
      const d = (n.data || {}) as { agent?: string; ts?: number };
      return !!d.agent && !!reads[d.agent] && Number(d.ts || 0) <= reads[d.agent];
    });
    if (dead.length) await p.removeDeliveredNotifications({ notifications: dead.map((n) => ({ id: n.id })) });
  } catch { /* 静默 */ }
}

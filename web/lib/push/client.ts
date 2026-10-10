"use client";
import { t, getLang } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";
import { notificationCleanupContext, shouldRemoveNotification } from "./unread-cleanup";
import { pushSubscribe, pushUnsubscribe, vapidPublicKey } from "@/lib/api/push";

/**
 * Web Push 客户端共用逻辑：设置页开关与首页引导条共用同一套订阅 / 退订流程。
 * 一个 origin 一份订阅：中继模式用中继的 VAPID 公钥订阅一次，订阅交给当前机器（bridge 要推时发 push 帧给中继投递，§7）；
 * 直托管用 bridge 自签的公钥。Notification.requestPermission 必须发生在用户手势里——调用方只能是按钮 onClick。
 */

/** base64url VAPID 公钥 → Uint8Array（pushManager.subscribe 要求） */
function urlB64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 当前环境是否具备推送能力（iOS 非主屏打开时 PushManager 不存在） */
export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;
}

/** 本设备现有订阅（null = 未订阅 / 不支持） */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null; // SW 注册读不到（隐私模式等）就当没订阅
  }
}

/** 开启推送：权限 → 订阅 → 交给当前机器。必须在用户手势里调用。 */
export async function enablePush(): Promise<{ ok: boolean; msg: string }> {
  if (!pushSupported()) return { ok: false, msg: "此环境不支持推送(iOS 需先「添加到主屏幕」并从主屏打开)" };
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, msg: "通知权限被拒绝——请在系统设置里允许后重试" };
    const key = await vapidPublicKey();
    if (!key) return { ok: false, msg: "这台机器 / 中继没有配置推送密钥" };
    // 每次「开启」都换全新订阅身份：先退掉残留的旧订阅再 subscribe（复用旧订阅救不回被 iOS 作废的那份）。
    // ⚠ 换公钥（切机器 / 中继换了 key）必须先退订，同一 registration 不能用另一把 key 订。
    const stale = await reg.pushManager.getSubscription();
    if (stale) await stale.unsubscribe().catch(() => {}); // 退不掉也照样重订，subscribe 会报错再说
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await pushSubscribe(sub.toJSON(), navigator.userAgent, key);
    // 本地测试通知（不走推送服务）：立刻能看到 = 展示层正常，之后收不到就是投递层
    try {
      await reg.showNotification(t("推送已开启 ✅"), { body: t("这条是本地测试——能看到它,说明通知展示没问题"), tag: "cstra-local-test", icon: "/icons/icon-192.png" });
    } catch {
      /* 本地测试通知弹不出来不影响订阅本身 */
    }
    return { ok: true, msg: "已开启:应该立刻弹了一条本地测试通知" };
  } catch (e) {
    return {
      ok: false,
      msg: getLang() === "zh" ? `开启失败:${(e as Error).message}(需要 HTTPS 或安装到主屏幕)` : `Enable failed: ${(e as Error).message} (requires HTTPS or install to Home Screen)`,
    };
  }
}

/**
 * 打开 App 时的本机通知补清（跨端已读对账的 iOS 半边）：别处已读的 agent，其存量通知在本机通知中心里静默关掉。
 * 非 iOS 平时靠 dismiss push 实时清，这里是兜底；iOS 收不到静默 push（展示惩罚），只能靠这条。失败静默。
 */
export async function cleanupReadNotifications(): Promise<void> {
  try {
    if (isNativeShell()) {
      const { cleanupDeliveredNative } = await import("./native");
      await cleanupDeliveredNative();
      return;
    }
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const ns = (await reg?.getNotifications()) ?? [];
    if (!ns.length) return;
    const c = await notificationCleanupContext(ns.map((n) => n.data || {}), false);
    for (const n of ns) if (shouldRemoveNotification(n.data || {}, c)) n.close();
  } catch {
    /* 无 SW / 凭据失效 / 机器离线都正常：留着通知不影响使用 */
  }
}

/** 关闭推送：退订 + 从当前机器删除 */
export async function disablePush(): Promise<{ ok: boolean; msg: string }> {
  const sub = await getPushSubscription();
  if (!sub) return { ok: true, msg: "本设备未订阅" };
  try {
    await pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
    return { ok: true, msg: "已关闭本设备推送" };
  } catch (e) {
    return { ok: false, msg: getLang() === "zh" ? `关闭失败:${(e as Error).message}` : `Disable failed: ${(e as Error).message}` };
  }
}

/** User explicitly cleared all: remove every notification delivered to this registration or native shell. */
export async function clearDeliveredNotifications(): Promise<void> {
  try {
    if (isNativeShell()) {
      const { clearDeliveredNative } = await import("./native");
      await clearDeliveredNative();
      return;
    }
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    for (const n of (await reg?.getNotifications()) ?? []) n.close();
  } catch { /* Server read-all already succeeded; unavailable local notification APIs must not retain UI unread counts. */ }
}

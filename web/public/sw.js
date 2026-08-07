/**
 * Claudestra Web Push Service Worker(owner 2026-07-16「做 pwa 推送」)。
 * - push:无条件展示通知(tag 由服务端 payload 决定;v2.17.2 起每条独立 tag,
 *   同 tag 在 iOS 是静默替换、不重新提醒,折叠已放弃)
 * - notificationclick:聚焦已有窗口,没有则新开 /chat
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = { title: "Claudestra", body: "", url: "/chat", tag: "cstra", agent: "" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    /* 非 JSON payload,用默认 */
  }
  event.waitUntil(
    Promise.all([
      // ⚠ 必须无条件 showNotification——iOS/Safari 对「push 到达却不展示」有
      // 惩罚:静默几次后开始丢弃该订阅的后续推送。前台重复感靠 tag 折叠;绝不静默。
      self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: payload.url, agent: payload.agent },
      }),
      // 回执探针(排障):push 事件到达即打点,区分投递层/展示层问题
      fetch(`/api/push/ack?tag=${encodeURIComponent(payload.tag)}`).catch(() => {}),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/chat";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          // 已有窗口:postMessage 让页面原地切到该 agent 会话(比 navigate 整页
          // 刷新顺滑;owner 2026-07-16「点通知切到具体 agent」)
          if (data.agent) w.postMessage({ type: "cstra-open-agent", agent: data.agent });
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

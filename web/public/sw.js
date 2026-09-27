/**
 * Claudestra Web Push Service Worker。
 * - push：无条件展示通知（iOS/Safari 对「push 到达却不展示」有惩罚，静默几次后丢弃该订阅的后续推送；每条独立 tag）；
 *   dismiss 型只清同 agent 的旧通知；badge 字段同步 App 图标角标。
 * - notificationclick：聚焦已有窗口（postMessage 原地切会话），没有则新开 /chat。点通知 = 已读：回执给**发通知的那台机器**
 *   （payload 里的 fp；老 payload 没有就用 IndexedDB 里记的当前机器）——凭据是 HttpOnly cookie，SW 的 fetch 自动带上。
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** 当前机器（web 端 lib/machines.ts 写进 IndexedDB meta 表：{fp, base}）；读不到 → null */
function currentMachine() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("cstra", 1);
      req.onerror = () => resolve(null);
      req.onupgradeneeded = () => {
        // 页面还没建过库（SW 先于页面唤醒）：建空表，别让 open 卡在 versionchange
        const db = req.result;
        if (!db.objectStoreNames.contains("machines")) db.createObjectStore("machines", { keyPath: "fp" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = () => {
        try {
          const get = req.result.transaction("meta", "readonly").objectStore("meta").get("current");
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

/** 已读回执：POST <base>/api/v1/agents/<agent>/read（+ notify-read 清 Discord 完成 @）。base 由 fp 推（中继 /m/<fp>）或取当前机器 */
async function markRead(agent, fp) {
  const cur = await currentMachine();
  const base = fp && cur && cur.fp !== fp && cur.base ? `/m/${fp}` : cur ? cur.base : fp ? `/m/${fp}` : "";
  const headers = { "Content-Type": "application/json", "x-cstra-device": "1" };
  const post = (p) => fetch(`${base}/api/v1/agents/${encodeURIComponent(agent)}/${p}`, { method: "POST", headers, body: "{}", credentials: "include" }).catch(() => {});
  await post("read");
  await post("notify-read");
}

self.addEventListener("push", (event) => {
  let payload = { title: "Claudestra", body: "", url: "/chat", tag: "cstra", agent: "", ts: 0, type: "", fp: "" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    /* 非 JSON payload,用默认 */
  }
  if (typeof payload.badge === "number" && self.navigator && typeof self.navigator.setAppBadge === "function") {
    try {
      if (payload.badge > 0) self.navigator.setAppBadge(payload.badge).catch(() => {});
      else if (typeof self.navigator.clearAppBadge === "function") self.navigator.clearAppBadge().catch(() => {});
    } catch {
      /* 不支持 Badging API 的环境静默跳过 */
    }
  }
  if (payload.type === "dismiss") {
    event.waitUntil(
      self.registration.getNotifications().then((ns) => {
        for (const n of ns) {
          const d = n.data || {};
          if (d.agent === payload.agent && (d.ts || 0) <= (payload.ts || Date.now())) n.close();
        }
      }),
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url, agent: payload.agent, ts: payload.ts || Date.now(), fp: payload.fp || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/chat";
  if (data.agent) event.waitUntil(markRead(data.agent, data.fp));
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          // 已有窗口：postMessage 让页面原地切到该 agent 会话（比 navigate 整页刷新顺滑）
          if (data.agent) w.postMessage({ type: "cstra-open-agent", agent: data.agent, fp: data.fp || "" });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

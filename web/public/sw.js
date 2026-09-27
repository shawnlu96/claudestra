/**
 * Claudestra Web Push Service Worker。
 * - push：无条件展示通知（iOS/Safari 对「push 到达却不展示」有惩罚，静默几次后丢弃该订阅的后续推送；每条独立 tag）；
 *   dismiss 型只清同 agent 的旧通知；badge 字段同步 App 图标角标。
 * - notificationclick：聚焦已有窗口（postMessage 原地切会话），没有则新开 /chat。点通知 = 已读：回执给**发通知的那台机器**
 *   （payload 里的 fp；老 payload 没有就用 IndexedDB 里记的当前机器）——凭据是 HttpOnly cookie，SW 的 fetch 自动带上。
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** IndexedDB「cstra」库（web 端 lib/machines.ts：machines 表 = 配对过的机器，meta.current = {fp, base}）里的一条；读不到 → null */
function idbGet(store, key) {
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
          const get = req.result.transaction(store, "readonly").objectStore(store).get(key);
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

const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;

/**
 * 已读回执发给谁：payload.fp（中继按发送方钉死，relay/push.ts bindSenderFp）。直托管只有一台机器，基址恒为 ""；
 * 中继模式下 fp 必须是合法指纹且是本浏览器配对过的机器，否则不发——payload 是机器写的，不能让它把带凭据的 POST 指向别处。
 */
async function receiptBase(fp) {
  const cur = await idbGet("meta", "current");
  if (cur && !cur.base) return "";
  // 中继模式的推送一定经中继（VAPID 是中继的），fp 必然被钉上；没 fp 的只可能是旧通知，别默认发给眼下的另一台机器
  if (!fp || !FP_RE.test(fp) || !(await idbGet("machines", fp))) return null;
  return `/m/${fp}`;
}

/** 已读回执：POST <base>/api/v1/agents/<agent>/read（+ notify-read 清 Discord 完成 @） */
async function markRead(agent, fp) {
  const base = await receiptBase(fp);
  if (base === null) return;
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
  const agent = typeof data.agent === "string" ? data.agent : "";
  if (agent) event.waitUntil(markRead(agent, data.fp));
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          // 已有窗口：postMessage 让页面原地切到该 agent 会话（比 navigate 整页刷新顺滑）
          if (agent) w.postMessage({ type: "cstra-open-agent", agent, fp: data.fp || "" });
          return;
        }
      }
      // 冷启动：只回 /chat（url 是机器写的，别让它把新窗口开到 /m/<别的机器>/… 上）；带上发通知的机器，
      // machine-gate 读 ?fp=（只认配对过的）先切机器，再由 ?agent= 打开会话
      let u = new URL(url, self.location.origin);
      if (u.origin !== self.location.origin || u.pathname !== "/chat") u = new URL("/chat", self.location.origin);
      if (typeof data.fp === "string" && FP_RE.test(data.fp)) u.searchParams.set("fp", data.fp);
      await self.clients.openWindow(u.pathname + u.search);
    })(),
  );
});

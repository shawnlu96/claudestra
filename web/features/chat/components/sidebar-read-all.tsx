"use client";
import { useRef, useState } from "react";
import { readAll } from "@/lib/api/push";
import { clearUnreadCounts } from "@/lib/push/unread-counts";
import { clearDeliveredNotifications } from "@/lib/push/client";
import { useChatStoreApi } from "../chat-store";

/** 「全部已读」（NAVBAR1 起在「我的」里，只给全权设备）：服务端清零成功才清本机通知与角标；busy 期间再点不重发 */
export function useReadAll(): { busy: boolean; clear: () => Promise<void> } {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const clear = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const r = await readAll();
      if (!r.ok) return;
      await clearDeliveredNotifications();
      clearUnreadCounts();
      await store.refreshAgents();
    } catch { /* Failed server request retains counts/notifications. Refresh failure after success keeps the cleared state. */ }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, clear };
}

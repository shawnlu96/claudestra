"use client";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { readAll } from "@/lib/api/push";
import { clearUnreadCounts } from "@/lib/push/unread-counts";
import { clearDeliveredNotifications } from "@/lib/push/client";
import { useChatStoreApi } from "../chat-store";
import { CheckCheckIcon } from "./line-icons";

export function SidebarReadAll() {
  const t = useT();
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
  return (
    <button type="button" disabled={busy} onClick={() => void clear()} title={t("全部已读")} aria-label={t("全部已读")}
      className={"flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors " +
        "hover:bg-base-300 hover:text-base-content focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"}>
      <CheckCheckIcon />
    </button>
  );
}

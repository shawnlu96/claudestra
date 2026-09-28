"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "@/features/chat/chat-store";
import { useChatNav } from "@/features/chat/components/nav-context";
import { uiAgentName } from "@/lib/chat/agents";
import { useT } from "@/lib/i18n";
import { agentLabel, askCounts } from "../asks-model";
import { asksStore, useAsks } from "../asks-store";
import { AsksDrawer } from "./asks-drawer";
import { InboxIcon } from "./ask-icons";

/**
 * 侧栏里的「待你处理」入口（owner 18:31 拍板放侧栏）：有事才出现，数字只数等你处理的，验收单独小字。
 * 同时挂抽屉和「新来一件卡活的」顶部横幅（owner 正在用时不推送，就靠它）。machineKey 变了整份重来。
 * 协作视图首页的「等你」读的也是这一份（collab-view.tsx → homeView 的 waits）。
 */
export function AsksEntry({ machineKey }: { machineKey: string }) {
  const t = useT();
  const store = useChatStoreApi();
  const nav = useChatNav();
  const { asks, open, banner } = useAsks();
  useEffect(() => asksStore.start(machineKey), [machineKey]);
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => asksStore.dismissBanner(), 8_000);
    return () => clearTimeout(id);
  }, [banner]);
  const c = askCounts(asks);
  const openChat = (agent: string) => {
    asksStore.closeDrawer();
    void store.openAgent(uiAgentName(agent));
    nav.toContent();
  };

  return (
    <>
      {c.waiting + c.accept > 0 && (
        <button
          type="button"
          onClick={() => asksStore.openDrawer()}
          className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-warning/15 px-3 py-2 text-left text-sm text-base-content transition-colors hover:bg-warning/25"
        >
          <span className="text-warning">
            <InboxIcon />
          </span>
          <span className="font-medium">{t("待你处理")}</span>
          {c.accept > 0 && <span className="text-[11px] opacity-60">{t("待验收 {n}", { n: c.accept })}</span>}
          {c.waiting > 0 && <span className="badge badge-warning badge-sm ml-auto font-semibold">{c.waiting}</span>}
        </button>
      )}
      {open && <AsksDrawer onOpenChat={openChat} />}
      {banner &&
        !open &&
        createPortal(
          <button
            type="button"
            onClick={() => asksStore.openDrawer(banner.id)}
            className="fixed inset-x-3 z-50 flex items-center gap-2 rounded-xl bg-warning px-3.5 py-2.5 text-left text-sm text-warning-content shadow-lg sm:left-auto sm:right-4 sm:w-96"
            style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
          >
            <InboxIcon />
            <span className="min-w-0 truncate">
              <span className="font-semibold">{t("待你处理")} · {agentLabel(banner.fromAgent, t)}</span> {banner.title}
            </span>
          </button>,
          document.body,
        )}
    </>
  );
}

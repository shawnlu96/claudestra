"use client";
import { useEffect, useState } from "react";
import { useChatStoreApi } from "@/features/chat/chat-store";
import { useChatNav } from "@/features/chat/components/nav-context";
import { fetchAsk } from "@/lib/api/asks";
import { useT } from "@/lib/i18n";
import { jumpToAsk } from "../ask-jump";
import { asksStore, useAsks } from "../asks-store";
import type { WebAsk } from "../asks-model";

/** 抽屉列表里没有的（结案超过 3 天、别的机器）按 id 单独取一次；进程内记住，同一条不重复取 */
const fetched = new Map<string, Promise<WebAsk | null>>();
function askById(id: string): Promise<WebAsk | null> {
  let p = fetched.get(id);
  if (!p) {
    p = fetchAsk(id).then((r) => r.ask).catch(() => null); // 看不见 / 已删：引用条只写「答复」不带标题
    fetched.set(id, p);
  }
  return p;
}

const TITLE_MAX = 40;

/**
 * owner 在「待你处理」卡片上作答后，聊天里自己那条消息上方的引用条（T11b 第 7 条）：「答复：<ask 标题前 40 字>」，点了跳回原消息。
 * askId 跟着消息存（直播事件带、历史从答复第一行解析），刷新、换设备都一样；标题取自 bridge（抽屉里有就直接用）。
 */
export function AskQuote({ id }: { id: string }) {
  const t = useT();
  const store = useChatStoreApi();
  const nav = useChatNav();
  const inList = useAsks().asks.find((a) => a.id === id) ?? null;
  const [loaded, setLoaded] = useState<WebAsk | null>(null);
  useEffect(() => {
    if (inList) return;
    let live = true;
    void askById(id).then((a) => live && setLoaded(a));
    return () => void (live = false);
  }, [id, inList]);
  const ask = inList ?? loaded;
  const title = ask ? Array.from(ask.title).slice(0, TITLE_MAX).join("") : "";
  const jump = () => {
    if (!ask) return;
    asksStore.closeDrawer();
    nav.toContent();
    void jumpToAsk(store, ask);
  };
  return (
    <button type="button" onClick={jump} disabled={!ask} className="mb-2 block max-w-full truncate border-l-2 border-primary/50 pl-2 text-left text-[12px] leading-snug text-base-content/60">
      {title ? t("答复：{title}", { title }) : t("答复「待你处理」")}
    </button>
  );
}

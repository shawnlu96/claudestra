"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { groupAsks } from "../asks-model";
import { asksStore, useAsks } from "../asks-store";
import { AskCard } from "./ask-card";
import { CloseIcon } from "./ask-icons";

/** 最近处理过的默认只露这么多张，点「更多」再展开 */
const RECENT_PREVIEW = 5;

/**
 * 「待你处理」抽屉：手机全屏、桌面右侧 440px；portal 到 body（移动端会话页在 transform 横滑容器里，fixed 会被困住）。
 * 三组：等你处理 / 待验收 / 最近处理过。打开时定位到 focus 那张（推送深链、横幅点进来）。
 */
export function AsksDrawer({ onOpenChat }: { onOpenChat: (agent: string) => void }) {
  const t = useT();
  const { asks, focus, canAnswer } = useAsks();
  const [now, setNow] = useState(() => Date.now());
  const [moreRecent, setMoreRecent] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (focus) document.getElementById(`ask-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, asks.length]);
  const g = groupAsks(asks);
  const recent = moreRecent ? g.recent : g.recent.slice(0, RECENT_PREVIEW);
  const card = (a: (typeof asks)[number]) => <AskCard key={a.id} ask={a} now={now} focused={a.id === focus} canAnswer={canAnswer} onOpenChat={onOpenChat} />;
  const section = (title: string, list: typeof asks) =>
    list.length > 0 && (
      <section className="flex flex-col gap-2.5">
        <h2 className="px-1 text-[12px] font-semibold uppercase tracking-wide opacity-50">
          {title} · {list.length}
        </h2>
        {list.map(card)}
      </section>
    );

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => asksStore.closeDrawer()}>
      <div
        role="dialog"
        aria-label={t("待你处理")}
        className="flex h-full w-full flex-col bg-base-200 sm:w-[440px] sm:border-l sm:border-base-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
          <span className="text-base font-semibold">{t("待你处理")}</span>
          <button type="button" aria-label={t("关闭")} className="btn btn-ghost btn-sm btn-square ml-auto" onClick={() => asksStore.closeDrawer()}>
            <CloseIcon />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 pt-1" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}>
          {g.waiting.length + g.accept.length === 0 && <p className="px-1 py-8 text-center text-sm opacity-50">{t("没有等你处理的事")}</p>}
          {section(t("等你处理"), g.waiting)}
          {section(t("待验收"), g.accept)}
          {section(t("最近处理过"), recent)}
          {!moreRecent && g.recent.length > RECENT_PREVIEW && (
            <button type="button" className="btn btn-ghost btn-sm self-center" onClick={() => setMoreRecent(true)}>
              {t("更多")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../chat-store";
import { useT } from "@/lib/i18n";

/**
 * 全屏启动页：landing + 加载一体（2026-07-13 owner：进入先卡「暂无会话」很久、
 * 加载文字太丑 → 全屏盖住整个入场过程）。
 *
 * - SSR 首帧就在场（agentsReady 初始 false），JS 加载/水合/首拉期间用户看到的
 *   是品牌页而不是空态文字；
 * - agents 首拉完成（ready）且展示满最短时长后淡出卸载——加载快时也不闪屏；
 * - bg-base-100 + token 配色，明暗主题自动跟随。
 */
const MIN_SHOW_MS = 600;
const FADE_MS = 500;

export function Splash() {
  const t = useT();
  const ready = useChatStore((s) => s.state.agentsReady);
  const mountedAt = useRef(Date.now());
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);
  // 底部署名:版本 + commit id（owner:不一定每次改动都发版,commit 才定位得准）
  const [ver, setVer] = useState<{ version: string; commit: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/version")
      .then((r) => r.json())
      .then((j: { version?: string; commit?: string }) => {
        if (alive && (j.version || j.commit)) setVer({ version: j.version ?? "", commit: j.commit ?? "" });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready || fading || gone) return;
    const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - mountedAt.current));
    const t = setTimeout(() => setFading(true), wait);
    return () => clearTimeout(t);
  }, [ready, fading, gone]);

  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [fading]);

  if (gone) return null;
  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[60] grid place-items-center bg-base-100 transition-opacity duration-500 ${
        fading ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div className="splash-in flex flex-col items-center">
        <div className="relative grid place-items-center">
          <span className="absolute size-20 rounded-full bg-primary/25 blur-2xl" />
          <span className="splash-mark relative text-[56px] leading-none text-primary">✦</span>
        </div>
        <div className="-mr-[0.3em] mt-7 text-[21px] font-semibold tracking-[0.3em] text-base-content">
          CLAUDESTRA
        </div>
        <div className="-mr-[0.14em] mt-2 text-xs tracking-[0.14em] text-base-content/40">
          {t("你的 Claude Code 指挥台")}
        </div>
        <div className="mt-9 flex gap-1.5">
          {[0, 0.2, 0.4].map((d) => (
            <span
              key={d}
              className="chat-dot size-1.5 rounded-full bg-base-content/40"
              style={{ animationDelay: `${d}s` }}
            />
          ))}
        </div>
      </div>
      {ver && (
        <div
          className="absolute inset-x-0 text-center font-mono text-[11px] tabular-nums text-base-content/30"
          style={{ bottom: "max(env(safe-area-inset-bottom), 16px)" }}
        >
          {ver.version && `v${ver.version}`}
          {ver.version && ver.commit && " · "}
          {ver.commit}
        </div>
      )}
    </div>
  );
}

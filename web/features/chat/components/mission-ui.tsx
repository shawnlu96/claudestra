"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { MissionInfo } from "@/lib/chat/agents";
import { fmtDueParts } from "../fmt-ts-parts";
import { isStale, nextRefreshMs, tipShift } from "../mission-time";

/**
 * Autopilot 的界面（bridge/local-api/mission.ts；推进在 bridge/mission.ts）：
 *   MissionBadge  侧栏行的图标 / 顶栏的「截止 今天 11:00」标记；额度用尽退避中显示「等到 明天 09:15」，悬停看全称与目标
 * 网页的「开启 Autopilot」弹框 2026-10-16 随入口下架（CLI `manager.ts mission start` 仍可开）；关闭入口在 agent-menu.tsx / agent-actions.tsx。
 */
type T = ReturnType<typeof useT>;
/** 常显短写（今天 / 明天 / MM-DD + HH:mm）与悬停全称（带日期与 UTC 偏移），规则在 fmt-ts-parts.ts fmtDueParts */
function due(t: T, iso: string, now: number): { short: string; full: string } {
  const p = fmtDueParts(iso, new Date(now));
  if (!p) return { short: "—", full: "—" };
  const day = p.day === "today" ? t("今天") : p.day === "tomorrow" ? t("明天") : p.date;
  return { short: `${day} ${p.hm}`, full: p.full };
}

/** lucide navigation：Autopilot 的统一标识（侧栏、顶栏徽章共用），线条风格与顶栏其他图标一致 */
export function MissionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

/** lucide circle-stop：关闭 Autopilot */
export function MissionStopIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

/** 「现在」：到下一个本地零点（今天 / 明天会变）或 resumeAt（「等到」换回「截止」）时自动刷新。
 *  延迟按真实时间算，不按 state 里的 now：bridge 退避中改 resumeAt 只重渲染、不重挂载，那个 now 可能是几小时前的；
 *  resumeAt 一变就立刻重取 now。计时器靠不住的两种情况另外兜底：iOS 冻结后台页面（回到前台时 visibilitychange），
 *  以及 macOS 合盖睡眠时 setTimeout 的时钟停走、标签页却一直可见（每分钟对一次，mission-time.ts isStale）。 */
function useNow(resumeAt?: string): number {
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(resumeAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const changed = seen.current !== resumeAt;
    seen.current = resumeAt;
    const id = setTimeout(tick, changed ? 0 : nextRefreshMs(Date.now(), resumeAt));
    const iv = setInterval(() => isStale(now, Date.now(), resumeAt) && tick(), 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(id);
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [now, resumeAt]);
  return now;
}

/** hover = 鼠标悬停（移开就收）；pin = 点按 / Enter / Space（点别处、失焦或 Esc 收）；focus = 键盘聚焦 */
type TipMode = "hover" | "pin" | "focus" | null;

/**
 * compact（侧栏行）：只一个图标，放在名字容器外面由行的 flex 居中——放进名字的文字流里会和字的基线错开。
 * 顶栏：与 ExternalBadge 同款的浅底小块，图标 +「截止 今天 11:00」；退避中图标转警示色、文字换成「等到 明天 09:15」。
 * slot：顶栏宽时和名字同一行（title，在「思考中」之前，回合进出不挪位），窄时放第二行徽章组（bar）——
 * 带日期的文字放第一行会把名字挤没。两处各渲染一份，用容器查询只显示一份。
 * 全称（日期 + UTC 偏移）与目标放在同款浮层里；浮层按实测宽度夹在屏幕内（mission-time.ts tipShift）。
 */
export function MissionBadge({ mission, compact = false, slot }: { mission: MissionInfo; compact?: boolean; slot?: "title" | "bar" }) {
  const t = useT();
  const now = useNow(mission.resumeAt);
  const [mode, setMode] = useState<TipMode>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const waiting = !!mission.resumeAt && Date.parse(mission.resumeAt) > now;
  const until = due(t, mission.until, now);
  const resume = waiting ? due(t, mission.resumeAt!, now) : null;
  const text = resume ? `${t("等到")} ${resume.short}` : `${t("截止")} ${until.short}`;
  const title =
    `${t("Autopilot 中")} · ${t("截止")} ${until.full} · ${t("已提醒")} ${mission.nudges}` + (resume ? `\n${t("等到")} ${resume.full}` : "") + `\n${mission.goal}`;
  // 浮层内容（多一行「等到」、目标变了）或视口（转屏、改窗口大小）变了都要重新夹一次
  useLayoutEffect(() => {
    const box = boxRef.current;
    const tip = tipRef.current;
    if (!mode || !box || !tip) return;
    const place = () => {
      tip.style.left = `${tipShift(box.getBoundingClientRect().left, tip.offsetWidth, window.innerWidth)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [mode, title]);
  useEffect(() => {
    if (mode !== "pin") return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setMode(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [mode]);
  const tone = waiting ? "text-warning" : "text-info";
  if (compact) {
    return (
      <span title={title} aria-label={title} className={`inline-flex shrink-0 items-center ${tone}`}>
        <MissionIcon size={12} />
      </span>
    );
  }
  const display = slot === "title" ? "hidden @xl:inline-flex" : slot === "bar" ? "inline-flex @xl:hidden" : "inline-flex";
  return (
    <span
      ref={boxRef}
      aria-label={title}
      aria-expanded={!!mode}
      role="button"
      tabIndex={0}
      onPointerEnter={(e) => e.pointerType === "mouse" && setMode((m) => m ?? "hover")}
      onPointerLeave={(e) => e.pointerType === "mouse" && setMode((m) => (m === "hover" ? null : m))}
      onClick={() => setMode((m) => (m === "pin" ? null : "pin"))}
      onKeyDown={(e) => {
        if (e.key === "Escape") setMode(null);
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setMode((m) => (m === "pin" ? null : "pin"));
      }}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && setMode((m) => m ?? "focus")}
      onBlur={() => setMode((m) => (m === "hover" ? m : null))}
      className={`relative ${display} shrink-0 cursor-default items-center gap-1 rounded-md bg-base-content/[0.08] px-1.5 py-1 text-[11px] leading-none text-base-content/60`}
    >
      <span className={tone}>
        <MissionIcon />
      </span>
      <span className="font-mono tabular-nums">{text}</span>
      <span
        ref={tipRef}
        role="tooltip"
        className={
          "pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[min(18rem,calc(100vw-16px))] rounded-lg border border-base-300 bg-base-100 " +
          `px-2.5 py-1.5 text-left text-[11px] font-normal leading-normal text-base-content shadow-lg ${mode ? "block" : "hidden"}`
        }
      >
        <span className="block text-[10px] text-base-content/50">
          {t("Autopilot 中")} · {t("已提醒")} {mission.nudges}
        </span>
        <span className="block font-mono tabular-nums">
          {t("截止")} {until.full}
        </span>
        {resume && (
          <span className="block font-mono tabular-nums text-warning">
            {t("等到")} {resume.full}
          </span>
        )}
        <span className="mt-1 line-clamp-4 block whitespace-pre-wrap break-words">{mission.goal}</span>
      </span>
    </span>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { startMission } from "@/lib/api/agents";
import type { MissionInfo } from "@/lib/chat/agents";
import type { AgentSession } from "../type";
import { fmtDueParts } from "../fmt-ts-parts";
import { CenteredModal } from "./centered-modal";

/**
 * 值守的界面（bridge/local-api/mission.ts；推进在 bridge/mission.ts）：
 *   MissionBadge  侧栏行的图标 / 顶栏的「截止 今天 11:00」标记；额度用尽退避中显示「等到 明天 09:15」，悬停看全称与目标
 *   MissionModal  「开始值守…」弹框：目标 + 截止时间（快捷：+2 / +4 / +8 小时，或手填 HH:MM）
 * 弹框单实例挂在 AgentMenu 的 portal 里，侧栏菜单与顶栏菜单都经 openMissionModal 打开。
 */
type T = ReturnType<typeof useT>;
/** 常显短写（今天 / 明天 / MM-DD + HH:mm）与悬停全称（带日期与 UTC 偏移），规则在 fmt-ts-parts.ts fmtDueParts */
function due(t: T, iso: string, now: number): { short: string; full: string } {
  const p = fmtDueParts(iso, new Date(now));
  if (!p) return { short: "—", full: "—" };
  const day = p.day === "today" ? t("今天") : p.day === "tomorrow" ? t("明天") : p.date;
  return { short: `${day} ${p.hm}`, full: p.full };
}

/** lucide navigation：值守的统一标识（侧栏、顶栏徽章、菜单、弹框共用），线条风格与顶栏其他图标一致 */
export function MissionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

/** lucide circle-stop：结束值守 */
export function MissionStopIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

/**
 * compact（侧栏行）：只一个图标，放在名字容器外面由行的 flex 居中——放进名字的文字流里会和字的基线错开。
 * 顶栏：与 ExternalBadge 同款的浅底小块，图标 +「截止 今天 11:00」；退避中图标转警示色、文字换成「等到 明天 09:15」。
 * 全称（日期 + UTC 偏移）与目标放在同款浮层里：桌面悬停，手机点一下（没有 hover），4 秒后自动收起。
 * 浮层默认左对齐徽章，徽章靠右、放不下时改右对齐，免得在手机上伸出屏幕。
 */
export function MissionBadge({ mission, compact = false }: { mission: MissionInfo; compact?: boolean }) {
  const t = useT();
  // 挂载时刻就够：resumeAt 变化会让列表签名变、整行重渲染（lib/chat/agents.ts agentExtraSig）
  const [now] = useState(() => Date.now());
  const [tip, setTip] = useState<{ open: boolean; right: boolean }>({ open: false, right: false });
  useEffect(() => {
    if (!tip.open) return;
    const id = setTimeout(() => setTip((s) => ({ ...s, open: false })), 4000);
    return () => clearTimeout(id);
  }, [tip.open]);
  const waiting = !!mission.resumeAt && Date.parse(mission.resumeAt) > now;
  const until = due(t, mission.until, now);
  const resume = waiting ? due(t, mission.resumeAt!, now) : null;
  const text = resume ? `${t("等到")} ${resume.short}` : `${t("截止")} ${until.short}`;
  const title =
    `${t("值守中")} · ${t("截止")} ${until.full} · ${t("已提醒")} ${mission.nudges}` + (resume ? `\n${t("等到")} ${resume.full}` : "") + `\n${mission.goal}`;
  const tone = waiting ? "text-warning" : "text-info";
  if (compact) {
    return (
      <span title={title} aria-label={title} className={`inline-flex shrink-0 items-center ${tone}`}>
        <MissionIcon size={12} />
      </span>
    );
  }
  const place = (el: HTMLElement, open: boolean) => setTip({ open, right: el.getBoundingClientRect().left + 288 > window.innerWidth - 16 });
  return (
    <span
      aria-label={title}
      role="button"
      tabIndex={0}
      onMouseEnter={(e) => place(e.currentTarget, false)}
      onClick={(e) => place(e.currentTarget, !tip.open)}
      className="group/mis relative inline-flex shrink-0 cursor-default items-center gap-1 rounded-md bg-base-content/[0.08] px-1.5 py-1 text-[11px] leading-none text-base-content/60"
    >
      <span className={tone}>
        <MissionIcon />
      </span>
      <span className="font-mono tabular-nums">{text}</span>
      <span
        role="tooltip"
        className={
          `pointer-events-none absolute ${tip.right ? "right-0" : "left-0"} top-full z-50 mt-1.5 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-base-300 ` +
          `bg-base-100 px-2.5 py-1.5 text-left text-[11px] font-normal leading-normal text-base-content shadow-lg ${tip.open ? "block" : "hidden"} lg:group-hover/mis:block`
        }
      >
        <span className="block text-[10px] text-base-content/50">
          {t("值守中")} · {t("已提醒")} {mission.nudges}
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

let open: ((a: AgentSession) => void) | null = null;
export function openMissionModal(a: AgentSession): void {
  open?.(a);
}

const PRESETS = [
  { label: "+2 小时", value: "+2h" },
  { label: "+4 小时", value: "+4h" },
  { label: "+8 小时", value: "+8h" },
];

export function MissionModal({ onStarted }: { onStarted: () => void }) {
  const t = useT();
  const [agent, setAgent] = useState<AgentSession | null>(null);
  const [goal, setGoal] = useState("");
  const [until, setUntil] = useState("+4h");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    open = (a) => {
      setAgent(a);
      setGoal("");
      setUntil("+4h");
      setErr("");
    };
    return () => {
      open = null;
    };
  }, []);
  if (!agent || typeof document === "undefined") return null;
  const close = () => setAgent(null);
  const submit = async () => {
    if (!goal.trim()) return setErr(t("写一句值守要推进的目标"));
    setBusy(true);
    setErr("");
    try {
      const r = await startMission(agent.name, { goal: goal.trim(), until: until.trim() });
      if (r.ok === false) throw new Error(r.error || "");
      onStarted();
      close();
    } catch (e) {
      setErr(`${t("开启失败：")}${(e as Error).message || t("请稍后再试")}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <CenteredModal onClose={close}>
      <div className="overflow-y-auto p-5" role="dialog" aria-modal="true">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-info">
            <MissionIcon size={16} />
          </span>
          <span className="min-w-0 truncate">
            {t("开始值守")} · {agent.label || t(agent.displayName)}
          </span>
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-base-content/60">
          {t("它每干完一轮，停一会儿确认你没在跟它说话，就自动接着推进；做完它自己宣告结束，到截止时间就收尾。Claude Code、Codex、Pi 都能用。")}
        </p>
        <label className="mt-4 block text-xs font-medium" htmlFor="mission-goal">
          {t("目标")}
        </label>
        <textarea
          id="mission-goal"
          className="textarea textarea-bordered mt-1 w-full text-sm"
          rows={3}
          value={goal}
          placeholder={t("比如：按台账一件件推进，能做的直接做，要拍板的记下来跳过")}
          onChange={(e) => setGoal(e.target.value)}
        />
        <label className="mt-3 block text-xs font-medium" htmlFor="mission-until">
          {t("截止时间")}
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.value} type="button" className={`btn btn-xs ${until === p.value ? "btn-primary" : "btn-ghost"}`} onClick={() => setUntil(p.value)}>
              {t(p.label)}
            </button>
          ))}
          <input
            id="mission-until"
            className="input input-bordered input-xs w-28 font-mono"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            placeholder="11:00"
          />
        </div>
        <p className="mt-1 text-[11px] text-base-content/50">{t("也可以填 11:00（已过就算明天）或 +90m")}</p>
        {err && <div className="mt-2 text-xs text-error">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
            {t("取消")}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : t("开始值守")}
          </button>
        </div>
      </div>
    </CenteredModal>
  );
}

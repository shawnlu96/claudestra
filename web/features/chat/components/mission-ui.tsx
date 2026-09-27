"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { startMission } from "@/lib/api/agents";
import type { MissionInfo } from "@/lib/chat/agents";
import type { AgentSession } from "../type";

/**
 * 值守的界面（bridge/local-api/mission.ts；推进在 bridge/mission.ts）：
 *   MissionBadge  侧栏行 / 顶栏的「⏱ 11:00」标记；额度用尽退避中显示「⏱ 等到 09:15」，悬停看目标
 *   MissionModal  「开始值守…」弹框：目标 + 截止时间（快捷：+2 / +4 / +8 小时，或手填 HH:MM）
 * 弹框单实例挂在 AgentMenu 的 portal 里，侧栏菜单与顶栏菜单都经 openMissionModal 打开。
 */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MissionBadge({ mission, compact = false }: { mission: MissionInfo; compact?: boolean }) {
  const t = useT();
  // 挂载时刻就够：resumeAt 变化会让列表签名变、整行重渲染（lib/chat/agents.ts agentExtraSig）
  const [now] = useState(() => Date.now());
  const waiting = !!mission.resumeAt && Date.parse(mission.resumeAt) > now;
  const text = waiting ? `${t("等到")} ${hhmm(mission.resumeAt!)}` : `→ ${hhmm(mission.until)}`;
  const title = `${t("值守中")} · ${t("截止")} ${hhmm(mission.until)} · ${t("已提醒")} ${mission.nudges}\n${mission.goal}`;
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 font-mono tabular-nums ${
        waiting ? "bg-warning/15 text-warning" : "bg-info/15 text-info"
      } ${compact ? "text-[10px] leading-4" : "text-[11px] leading-5"}`}
    >
      ⏱{compact ? "" : ` ${text}`}
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
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4" onClick={close}>
      <div className="w-full max-w-md rounded-2xl bg-base-100 p-5 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="text-base font-semibold">
          ⏱ {t("开始值守")} · {agent.label || t(agent.displayName)}
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
    </div>,
    document.body,
  );
}

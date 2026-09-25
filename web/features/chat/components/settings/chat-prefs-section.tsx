"use client";
import { useT } from "@/lib/i18n";
import { CHAT_DEFAULTS, CHAT_RANGES, EMPTY_CHAT_PREFS, type ChatPrefs, clampPref, setChatPrefs, useChatPrefs } from "@/lib/chat-prefs";
import { Section } from "./section";
import { ResetIcon } from "./reset-icon";

type Key = keyof ChatPrefs;

/**
 * 一行滑杆：标签 / range / 当前值 / 单项重置。拖动即写 store，立即生效。
 * 不标「默认」字样（owner 2026-09-25：重置时文字突变很奇怪）——是否在默认值只体现在重置钮是否可点。
 */
function SliderRow({ k, label, unit, prefs }: { k: Key; label: string; unit: string; prefs: ChatPrefs }) {
  const t = useT();
  const r = CHAT_RANGES[k];
  const v = prefs[k];
  const shown = v ?? CHAT_DEFAULTS[k];
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <span className="w-20 shrink-0 text-xs font-medium text-base-content/70">{label}</span>
      <input
        type="range"
        aria-label={label}
        className="range range-xs flex-1"
        min={r.min}
        max={r.max}
        step={r.step}
        value={shown}
        onChange={(e) => setChatPrefs({ ...prefs, [k]: clampPref(k, e.target.value) })}
      />
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-base-content/60">
        {shown}
        {unit}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square text-base-content/50"
        title={t("恢复默认")}
        aria-label={`${label} · ${t("恢复默认")}`}
        disabled={v === null}
        onClick={() => setChatPrefs({ ...prefs, [k]: null })}
      >
        <ResetIcon size={13} />
      </button>
    </div>
  );
}

/**
 * 外观 · 会话历史：正文字号（本人 / peer 气泡 + AI 正文）、行高、旁白字号（旁白 + 思考）、
 * 工具调用字号。跟主题 / 字体不同，这里不设「应用」——滑杆天然期待即时反馈，桌面上弹窗背后
 * 就是会话区能直接看到。右上角整体重置，每行末尾单项重置。
 */
export function ChatPrefsSection() {
  const t = useT();
  const prefs = useChatPrefs();
  const dirty = prefs.fontSize !== null || prefs.lineHeight !== null || prefs.narrSize !== null || prefs.toolSize !== null;
  return (
    <Section
      title={t("会话历史")}
      aside={
        <button
          className="btn btn-ghost btn-sm gap-1.5 border-base-300"
          title={t("全部恢复默认")}
          disabled={!dirty}
          onClick={() => setChatPrefs(EMPTY_CHAT_PREFS)}
        >
          <ResetIcon />
          {t("恢复默认")}
        </button>
      }
      desc={t("正文字号：本人 / peer 气泡与 AI 正文；旁白字号：旁白与思考；工具字号：工具调用行。拖动即时生效，只存在本设备。")}
    >
      <div className="space-y-3">
        <SliderRow k="fontSize" label={t("正文字号")} unit="px" prefs={prefs} />
        <SliderRow k="lineHeight" label={t("行高")} unit="" prefs={prefs} />
        <SliderRow k="narrSize" label={t("旁白字号")} unit="px" prefs={prefs} />
        <SliderRow k="toolSize" label={t("工具调用字号")} unit="px" prefs={prefs} />
      </div>
    </Section>
  );
}

"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { type FontPrefs, localFontsSupported, readLocalFonts, setFontPrefs, useFontPrefs } from "@/lib/font-prefs";
import { Section } from "./section";
import { ResetIcon } from "./reset-icon";

const LIST_ID = "cstra-font-families";

/** 常见字体族预设：本机装了就生效，没装按 fallback 链回退。datalist 里与本机字体合并。 */
const PRESETS = [
  "system-ui",
  "-apple-system",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Songti SC",
  "Noto Serif CJK SC",
  "Source Han Serif SC",
  "Georgia",
  "Times New Roman",
  "Iowan Old Style",
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "Fira Code",
  "Cascadia Code",
];

const SAMPLE = "Claudestra 快速的棕色狐狸跳过懒狗 0123456789 Aa Gg Qq";

function FontRow({ label, value, onChange, generic }: { label: string; value: string; onChange: (v: string) => void; generic: string }) {
  const t = useT();
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs font-medium text-base-content/70">{label}</span>
        <input
          type="text"
          list={LIST_ID}
          className="input input-bordered input-sm min-w-0 flex-1 font-mono text-[12px]"
          placeholder={t("留空 = 跟随系统")}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div
        className="mt-1 truncate pl-14 text-[13px] text-base-content/60"
        style={{ fontFamily: value ? `${value}, ${generic}` : generic }}
      >
        {SAMPLE}
      </div>
    </div>
  );
}

/** 读本机字体的按钮 + 结果提示；families 合进 datalist */
function LocalFontsButton({ onFonts }: { onFonts: (families: string[]) => void }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "ok" | "denied">("idle");
  const [count, setCount] = useState(0);
  if (!localFontsSupported()) {
    return <span className="text-[11px] text-base-content/40">{t("本浏览器不能读本机字体（仅桌面 Chrome / Edge，且需 HTTPS 或 localhost）；可直接输入字体名。")}</span>;
  }
  return (
    <span className="flex items-center gap-2 text-[11px] text-base-content/50">
      <button
        className="btn btn-ghost btn-xs border-base-300"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          void readLocalFonts().then((r) => {
            if (r.status === "ok") {
              onFonts(r.families);
              setCount(r.families.length);
              setState("ok");
            } else setState("denied");
          });
        }}
      >
        {t("读取本机字体")}
      </button>
      {state === "ok" && `${t("已读取")} ${count} ${t("个字体族，输入框可下拉选择")}`}
      {state === "denied" && t("读取被拒绝或失败")}
    </span>
  );
}

/**
 * 外观 · 字体：正文 / 衬线 / 等宽三族 + 会话正文衬线开关，按设备保存。输入框带 datalist
 * （预设 + 读到的本机字体），下方一行即时预览。「应用」才生效。
 */
export function FontSection() {
  const t = useT();
  const saved = useFontPrefs();
  const [draft, setDraft] = useState<FontPrefs>(saved);
  const [local, setLocal] = useState<string[]>([]);
  const dirty = draft.sans !== saved.sans || draft.serif !== saved.serif || draft.mono !== saved.mono || draft.chatSerif !== saved.chatSerif;
  const anySet = Boolean(draft.sans || draft.serif || draft.mono || draft.chatSerif || saved.sans || saved.serif || saved.mono || saved.chatSerif);
  const patch = (p: Partial<FontPrefs>) => setDraft((d) => ({ ...d, ...p }));
  const families = Array.from(new Set([...PRESETS, ...local]));
  return (
    <Section
      title={t("字体")}
      aside={
        <div className="flex gap-1.5">
          <button
            className="btn btn-ghost btn-sm gap-1.5 border-base-300"
            title={t("恢复默认")}
            disabled={!anySet}
            onClick={() => {
              const empty: FontPrefs = { sans: "", serif: "", mono: "", chatSerif: false };
              setDraft(empty);
              setFontPrefs(empty);
            }}
          >
            <ResetIcon />
            {t("恢复默认")}
          </button>
          <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => setFontPrefs(draft)}>
            {t("应用")}
          </button>
        </div>
      }
      desc={t("整站字体族：正文（界面与会话）、衬线、等宽（代码）。可填多个用逗号分隔，本机没装的会按顺序回退；只存在本设备。")}
    >
      <datalist id={LIST_ID}>
        {families.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="space-y-3">
        <FontRow label={t("正文")} value={draft.sans} onChange={(v) => patch({ sans: v })} generic="sans-serif" />
        <FontRow label={t("衬线")} value={draft.serif} onChange={(v) => patch({ serif: v })} generic="serif" />
        <FontRow label={t("等宽")} value={draft.mono} onChange={(v) => patch({ mono: v })} generic="monospace" />
        <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
          <span>{t("会话正文用衬线体")}</span>
          <input type="checkbox" className="toggle toggle-sm" checked={draft.chatSerif} onChange={(e) => patch({ chatSerif: e.target.checked })} />
        </label>
        <LocalFontsButton onFonts={setLocal} />
      </div>
    </Section>
  );
}

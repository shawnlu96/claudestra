"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { parseThemeVars, setThemeVars, useThemeVars } from "@/lib/theme-vars";
import { Section } from "./section";

const GENERATOR_URL = "https://daisyui.com/theme-generator/";

/** 一段粘贴框 + 解析反馈；解析只用于提示，点「应用」才生效。 */
function VarsBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const { vars, ignored } = parseThemeVars(value);
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-base-content/70">{label}</span>
        <span className="text-base-content/40">
          {value.trim()
            ? `${t("识别到")} ${vars.length} ${t("个变量")}${ignored ? ` · ${t("忽略")} ${ignored} ${t("行")}` : ""}`
            : t("未设置")}
        </span>
      </div>
      <textarea
        className="textarea textarea-bordered w-full font-mono text-[11.5px] leading-snug"
        rows={5}
        spellCheck={false}
        placeholder={'@plugin "daisyui/theme" {\n  --color-primary: oklch(60% 0.2 250);\n  --radius-field: 0.5rem;\n}'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * 外观 · 自定义主题变量：把 daisyUI 主题生成器的输出整段粘进来（浅色 / 深色各一段），
 * 「应用」即生效，按设备保存。解析规则与存储在 lib/theme-vars.ts。
 */
export function ThemeVarsSection() {
  const t = useT();
  const saved = useThemeVars();
  const [light, setLight] = useState(saved.light);
  const [dark, setDark] = useState(saved.dark);
  const dirty = light !== saved.light || dark !== saved.dark;
  const hasSaved = Boolean(saved.light.trim() || saved.dark.trim());
  return (
    <Section
      title={t("自定义主题变量")}
      aside={
        <div className="flex gap-1.5">
          <button
            className="btn btn-ghost btn-sm border-base-300"
            disabled={!hasSaved && !light.trim() && !dark.trim()}
            onClick={() => {
              setLight("");
              setDark("");
              setThemeVars({ light: "", dark: "" });
            }}
          >
            {t("恢复默认")}
          </button>
          <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => setThemeVars({ light, dark })}>
            {t("应用")}
          </button>
        </div>
      }
      desc={
        <>
          {t("把 daisyUI 主题生成器输出的整段粘进来即可，只读取 --变量: 值 这类行，其余忽略；立即生效，只存在本设备。")}{" "}
          <a className="link" href={GENERATOR_URL} target="_blank" rel="noreferrer">
            {t("打开生成器")}
          </a>
        </>
      }
    >
      <div className="space-y-3">
        <VarsBox label={t("浅色")} value={light} onChange={setLight} />
        <VarsBox label={t("深色")} value={dark} onChange={setDark} />
      </div>
    </Section>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useT, useLang, setLang } from "@/lib/i18n";
import { useThemePref, setThemePref } from "@/lib/theme";
import { kbFixEnabled, setKbFixEnabled } from "../../use-keyboard-viewport";
import { Section } from "./section";
import { setDevMode } from "../../../devtools/dev-mode";
import { useDevMode } from "../../../devtools/dev-mount";

/** 界面 · 外观（跟随系统 / 浅色 / 深色） */
export function AppearanceSection() {
  const t = useT();
  const themePref = useThemePref();
  return (
        <Section
          title={t("外观")}
          aside={
            <div className="join">
              {(
                [
                  ["auto", t("跟随系统")],
                  ["light", t("浅色")],
                  ["dark", t("深色")],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={`btn btn-sm join-item ${themePref === v ? "btn-primary" : "btn-ghost border-base-300"}`}
                  onClick={() => setThemePref(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
  );
}

/** 界面 · 语言 */
export function LanguageSection() {
  const lang = useLang();
  return (
        <Section
          title="语言 / Language"
          aside={
            <div className="join">
              <button
                className={`btn btn-sm join-item ${lang === "zh" ? "btn-primary" : "btn-ghost border-base-300"}`}
                onClick={() => setLang("zh")}
              >
                中文
              </button>
              <button
                className={`btn btn-sm join-item ${lang === "en" ? "btn-primary" : "btn-ghost border-base-300"}`}
                onClick={() => setLang("en")}
              >
                English
              </button>
            </div>
          }
        />
  );
}

/** iOS 键盘修正实验开关(use-keyboard-viewport):挂载时读 localStorage */
export function useKbFixToggle() {
  const [kbFixOn, setKbFixOn] = useState(false);
  useEffect(() => setKbFixOn(kbFixEnabled()), []);
  return { kbFixOn, setKbFixOn };
}

/** iOS 键盘修正(实验,2026-07-27 重构) */
export function KbFixSection({ kbFix }: { kbFix: ReturnType<typeof useKbFixToggle> }) {
  const t = useT();
  const { kbFixOn, setKbFixOn } = kbFix;
  return (
        <Section
          title={t("iOS 键盘修正（实验）")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={kbFixOn}
              onChange={() => {
                setKbFixEnabled(!kbFixOn);
                setKbFixOn(!kbFixOn);
                // 钩子在页面挂载时读开关——刷新生效,PWA 里 reload 即可
                window.location.reload();
              }}
            />
          }
          desc={t("Telegram 式文档流布局：修正 iOS 弹键盘时输入光标/附件菜单错位。有任何异常关掉即恢复原布局。")}
        />
  );
}

/** 开发者模式总开关(features/devtools):切换即时生效,面板按需加载。范式见 docs/web-dev-mode.md */
export function DevModeSection() {
  const t = useT();
  const devOn = useDevMode();
  return (
    <Section
      title={t("开发者模式")}
      aside={<input type="checkbox" className="toggle toggle-sm shrink-0" checked={devOn} onChange={() => setDevMode(!devOn)} />}
      desc={t("右下角出现调试面板：帧率 / 帧间隔 / 提交突发 / DOM 与消息计数 / 视口实测值 / 最近事件。URL 加 ?dev=1 也能打开。")}
    />
  );
}

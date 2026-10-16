"use client";
import { useV2T } from "../../../nav/nav-v2";
import { Section } from "./section";
import { useSettingsFlag } from "./settings-flag";

/**
 * navV2 一键回退（NAVV2-SHELLA1）：设置「通用」页和新版「设置」页都挂这一块，同一个 useSettingsFlag，写成功后外壳当场换。
 * 全局开关，PUT 要 manage：非全权设备整块不渲染（调用方按 full 判），不留一个点了必 403 的开关。
 */
export function NavV2Section() {
  const t = useV2T();
  const f = useSettingsFlag("navV2");
  return (
    <Section title={t("新版导航")} desc={t("整页显示今天、项目、团队与我的；关掉回到旧布局，会话与设置两种布局都在。")} aside={
      <input type="checkbox" className="toggle toggle-sm shrink-0" checked={f.on === true} aria-label={t("新版导航")} data-nav-v2-toggle
        disabled={f.busy || f.on === null} onChange={() => void f.toggle()} />
    }>
      <div className="text-xs text-base-content/45">{t("全局生效，只有全权设备能改")}</div>
      {f.err ? <div className="text-xs text-error">{f.err}</div> : null}
    </Section>
  );
}

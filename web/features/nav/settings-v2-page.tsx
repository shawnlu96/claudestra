"use client";
/**
 * 新版「设置」页（NAVV2-SHELLA1 骨架）：顶上是新版导航一键回退，下面是这台设备能看的设置页（settingsPagesFor，受限设备不出全权页），
 * 点一行打开原设置弹窗的那一页（openSettings，弹窗仍由 Sidebar 持有）；不在这里重做设置内容。
 */
import { useT } from "@/lib/i18n";
import { useFullScope } from "../chat/contacts-data";
import { NavV2Section } from "../chat/components/settings/nav-v2-section";
import { SETTINGS_PAGES, settingsPagesFor } from "../chat/components/settings/nav";
import { openSettings } from "../chat/settings-open";
import type { V2PageProps } from "./nav-v2";
import css from "./v2-shell.module.css";

export function SettingsV2Page(p: V2PageProps) {
  const t = useT();
  const full = useFullScope() === true;
  const pages = settingsPagesFor(full);
  return (
    <div className="flex flex-col gap-3 px-2" data-v2-page="settings" data-v2-from={p.from ?? undefined}>
      {full && <NavV2Section />}
      <div className={css.list}>
        {SETTINGS_PAGES.filter((s) => pages.includes(s.id)).map((s) => (
          <button key={s.id} type="button" className={css.row} data-v2-settings={s.id} onClick={() => openSettings(s.id)}>
            <svg className={css.rowIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden>{s.icon}</svg>
            <span className={css.rowLabel}>{t(s.label)}</span>
            <svg className={css.chev} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
          </button>
        ))}
      </div>
    </div>
  );
}

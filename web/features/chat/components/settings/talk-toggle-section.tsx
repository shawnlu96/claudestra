"use client";
import { useT } from "@/lib/i18n";
import { announceTalkEnabled } from "@/features/talk/use-talk-enabled";
import { Section } from "./section";
import { useSettingsFlag } from "./settings-flag";

/** Chat（人与人）入口：整台电脑的开关，缺省关（lib/talk-gate.ts）。改完已挂载的侧栏立刻跟上 */
export function TalkToggleSection() {
  const t = useT();
  const f = useSettingsFlag("talkEnabled", true, announceTalkEnabled);
  return (
    <Section
      title={t("Chat（人与人）")}
      aside={<input type="checkbox" className="toggle toggle-sm shrink-0" checked={f.on === true} disabled={f.busy || f.on === null} onChange={() => void f.toggle()} />}
      desc={t("打开后侧栏顶部出现「工作台 | Chat」切换，可以和这台电脑的 guest 聊天。关着时入口收起，聊天记录照旧保留。")}
    >
      {f.err ? <div className="text-xs text-error">{f.err}</div> : null}
    </Section>
  );
}

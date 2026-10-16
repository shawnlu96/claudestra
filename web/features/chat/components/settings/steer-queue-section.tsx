"use client";
import { useT } from "@/lib/i18n";
import { Section } from "./section";
import { useSettingsFlag } from "./settings-flag";

export function SteerQueueSection() {
  const t = useT();
  const f = useSettingsFlag("steer.queueWhenBusy");
  return (
    <Section title={t("忙时排队")} aside={
      <input type="checkbox" className="toggle toggle-sm shrink-0" checked={f.on === true}
        disabled={f.busy || f.on === null} onChange={() => void f.toggle()} />
    }>
      {f.err ? <div className="text-xs text-error">{f.err}</div> : null}
    </Section>
  );
}

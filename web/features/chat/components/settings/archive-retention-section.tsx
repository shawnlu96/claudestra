"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";
import { getArchiveRetention, putArchiveRetention } from "@/lib/api/settings";

/** 归档保留天数（0 = 永不自动清理）。缺省 90 天 —— 超期由 bridge 的每日兜底删除。 */
export function ArchiveRetentionSection() {
  const t = useT();
  const [days, setDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getArchiveRetention()
      .then((j) => setDays(j.days ?? 90))
      .catch(() => setDays(90));
  }, []);
  const save = async (next: number) => {
    setSaving(true);
    setSaved(false);
    try {
      const j = await putArchiveRetention(next);
      setDays(j.days ?? next);
      setSaved(true);
    } catch {
      setSaved(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section
      title={t("归档保留")}
      desc={t("已退役会话的归档保留天数；超期由每日兜底清理，0 = 永不清理（归档是「可找回的过期会话」，不是永久仓库）。")}
      aside={
        <select
          className="select select-bordered select-sm"
          value={days ?? 90}
          disabled={days === null || saving}
          onChange={(e) => void save(Number(e.target.value))}
        >
          {[30, 90, 180, 365, 0].map((d) => (
            <option key={d} value={d}>
              {d === 0 ? t("永不清理") : t("{n} 天", { n: d })}
            </option>
          ))}
        </select>
      }
    >
      {saved ? <span className="text-xs text-success">{t("已保存")}</span> : null}
    </Section>
  );
}

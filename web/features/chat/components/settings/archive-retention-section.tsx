"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/** 归档保留天数（0 = 永不自动清理）。缺省 90 天 —— 超期由 bridge 的每日兜底删除。 */
export function ArchiveRetentionSection() {
  const t = useT();
  const [days, setDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    fetch("/api/settings/archive-retention")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { days?: number } } | null) => setDays(j?.data?.days ?? 90))
      .catch(() => setDays(90));
  }, []);
  const save = async (next: number) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/archive-retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: next }),
      });
      const j = (await res.json()) as { data?: { days?: number }; error?: string };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDays(j.data?.days ?? next);
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
              {d === 0 ? t("永不清理") : `${d} ${t("天")}`}
            </option>
          ))}
        </select>
      }
    >
      {saved ? <span className="text-xs text-success">{t("已保存")}</span> : null}
    </Section>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { putQuotaSettings, quotaSettings } from "@/lib/api/system";
import { Section } from "./section";

/**
 * 订阅额度的实时读取开关（bridge /api/v1/quota/settings，缺省开）。关了 bridge 不读 Keychain / auth.json、不调订阅接口，
 * 用量看板只显示本机缓存。只有本机 owner 拿得到（其它凭据 403）→ 整块不显示。
 */
export function QuotaLiveSection() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    quotaSettings()
      .then((j) => setEnabled(j.enabled))
      .catch(() => setEnabled(null)); // 非 owner / 老 bridge：不给这个开关
  }, []);
  if (enabled === null) return null;
  const save = async (next: boolean) => {
    setBusy(true);
    try {
      setEnabled((await putQuotaSettings(next)).enabled);
    } catch {
      // 没写成：开关停在原位，用户看得到没变
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title={t("订阅额度实时读取")}
      desc={t("用 Claude Code / codex 已登录的凭据，只读查询订阅额度和免费重置次数：看用量时实时查，后台每 6 小时查一次（快过期提醒靠它）。Pi 里配置的 DeepSeek / OpenCode Go / Kimi 也用各自的 API key 查余额和套餐用量（只在看用量时查）。关掉后只显示本机缓存。")}
      aside={
        <input type="checkbox" className="toggle toggle-sm" checked={enabled} disabled={busy} onChange={(e) => void save(e.target.checked)} />
      }
    />
  );
}

"use client";
/**
 * 中继卡里的「严格模式」开关（bridge/peer-relay-strict.ts）：开了以后，经中继打开的页面不能加入加密邀请。
 * 只有 owner 设备能改（别的设备只看得到状态）；在中继页面上只能打开、不能关——关要回本机页面或让大总管跑 peer-relay-strict off，
 * 所以那种情况开关直接置灰。读不到（老 bridge 没这个接口）就不显示。
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api/client";

interface StrictView {
  ok?: boolean;
  strict?: boolean;
  viaRelayPage?: boolean;
  canSet?: boolean;
  error?: string;
}

const PATH = "/peers/relay-strict";

export function RelayStrictRow() {
  const t = useT();
  const [v, setV] = useState<StrictView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    api<StrictView>(PATH, { timeoutMs: 8000 })
      .then((r) => live && setV(r))
      .catch(() => live && setV(null)); // 老 bridge 没这个接口：整行不显示，不影响中继卡其余部分
    return () => {
      live = false;
    };
  }, []);

  if (!v?.ok) return null;
  const lockedOn = !!v.strict && !!v.viaRelayPage;
  const toggle = async () => {
    setBusy(true);
    setErr("");
    try {
      setV(await api<StrictView>(PATH, { method: "POST", json: { strict: !v.strict }, timeoutMs: 8000 }));
    } catch (e) {
      setErr((e as Error).message || t("切换失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 border-t border-base-content/5 pt-3 text-xs">
      <label className="flex items-center justify-between gap-3">
        <span className="font-medium">{t("严格模式")}</span>
        <input
          type="checkbox"
          className="toggle toggle-xs shrink-0"
          checked={!!v.strict}
          disabled={busy || !v.canSet || lockedOn}
          onChange={() => void toggle()}
        />
      </label>
      <p className="mt-0.5 leading-relaxed text-base-content/50">{t("开了以后，经中继打开的页面不能加入加密邀请")}</p>
      {err && <div className="mt-1 text-error">{err}</div>}
    </div>
  );
}

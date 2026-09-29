"use client";
import { useEffect, useState } from "react";
import { getSettings, putSettings } from "@/lib/api/settings";

/**
 * config.json 里整台电脑的布尔开关（bridge GET/PUT /settings），不是本设备的：「推送不带正文」「Chat 入口」共用。
 * 写要 manage 权限，guest 点了拿到 403 就把错误显示出来；onChanged 在写成功后收到新值。
 */
export function useSettingsFlag(key: "pushNoContent" | "talkEnabled", open = true, onChanged?: (on: boolean) => void) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    getSettings()
      .then((j) => setOn(j[key]))
      .catch((e: Error) => setErr(e.message));
  }, [open, key]);
  const toggle = async () => {
    if (on === null) return;
    setBusy(true);
    setErr("");
    try {
      const next = (await putSettings({ [key]: !on }))[key];
      setOn(next);
      onChanged?.(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { on, busy, err, toggle };
}

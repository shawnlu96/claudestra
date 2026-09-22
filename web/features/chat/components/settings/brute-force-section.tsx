"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/** 登录安全(owner 2026-08-09):累进封禁开关。TOTP 由 TotpSection 自管 */
export function useBruteForce(open: boolean) {
  const [bruteForceOn, setBruteForceOn] = useState(true);
  const [secBusy, setSecBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 登录安全配置
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((j: { bruteForceOn?: boolean }) => {
        setBruteForceOn(j.bruteForceOn !== false);
      })
      .catch(() => {});
  }, [open]);

  const toggleBruteForce = async () => {
    const next = !bruteForceOn;
    setSecBusy(true);
    setBruteForceOn(next); // 乐观
    try {
      const r = await fetch("/api/auth/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bruteForceOn: next }),
      });
      if (!r.ok) setBruteForceOn(!next); // 回滚
    } catch {
      setBruteForceOn(!next);
    } finally {
      setSecBusy(false);
    }
  };

  return { bruteForceOn, secBusy, toggleBruteForce };
}

export function BruteForceSection({ sec }: { sec: ReturnType<typeof useBruteForce> }) {
  const t = useT();
  const { bruteForceOn, secBusy, toggleBruteForce } = sec;
  return (
        <Section
          title={t("登录安全 · 失败封禁")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={bruteForceOn}
              disabled={secBusy}
              onChange={() => void toggleBruteForce()}
            />
          }
          desc={t("连续登录失败越多，锁定越久（5次→1分钟，逐级升到60分钟），登录成功即清零。防密码爆破/喷洒。默认开启，不影响正常登录。")}
        />
  );
}

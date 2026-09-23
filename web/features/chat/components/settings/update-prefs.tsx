"use client";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * 「版本与更新」里的通道 / 自动更新开关，以及「能升到哪个版本」的检查。
 * 数据都在 bridge（config.json + 远端查询），见 src/bridge/update-routes.ts。
 */
export type UpdateChannel = "release" | "beta";
export type UpdatePrefs = { channel: UpdateChannel; claudestra: boolean; claudeCode: boolean };
export type UpdateCheck = { channel: UpdateChannel; latest: string | null; behind?: number; upToDate: boolean | null; error?: string };

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string }; // 非 JSON 错误页按空体处理，下面按状态码报错
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** 通道 + 两个开关：读一次，改哪项 POST 哪项，以服务端回来的为准 */
export function useUpdatePrefs() {
  const [prefs, setPrefs] = useState<UpdatePrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<{ autoUpdate: UpdatePrefs }>("/api/update/settings")
      .then((j) => setPrefs(j.autoUpdate))
      .catch((e: Error) => setErr(e.message));
  }, []);
  const save = useCallback(async (patch: Partial<UpdatePrefs>) => {
    setBusy(true);
    setErr("");
    try {
      const j = await getJson<{ autoUpdate: UpdatePrefs }>("/api/update/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setPrefs(j.autoUpdate);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { prefs, busy, err, save };
}

/** 能升到哪个版本。key 变（切通道 / 升级完成）就重查 */
export function useUpdateCheck(key: string) {
  // 结果按 key 记：key 一变旧结果自动作废（显示「正在检查」），不用在 effect 里同步清空
  const [res, setRes] = useState<{ key: string; check: UpdateCheck | null; err: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    getJson<UpdateCheck>("/api/update/check")
      .then((check) => live && setRes({ key, check, err: "" }))
      .catch((e: Error) => live && setRes({ key, check: null, err: e.message }));
    return () => {
      live = false;
    };
  }, [key]);
  return res?.key === key ? { check: res.check, err: res.err } : { check: null, err: "" };
}

/** 「能升到哪个版本」一行字 */
export function UpdateTarget({ check, err }: { check: UpdateCheck | null; err: string }) {
  const t = useT();
  if (err) return <span className="text-error">{t("检查失败")}: {err}</span>;
  if (!check) return <span className="opacity-60">{t("正在检查新版本…")}</span>;
  if (check.upToDate === null) return <span className="text-warning">{t("查不到最新版本")}: {check.error}</span>;
  if (check.channel === "beta") {
    return check.upToDate
      ? <span className="opacity-60">{t("已是 main 最新")}（{check.latest}）</span>
      : <span className="text-success">{t("main 有新提交，可升级")}（{check.behind ?? "?"} → {check.latest}）</span>;
  }
  return check.upToDate
    ? <span className="opacity-60">{t("已是最新正式版")}（{check.latest}）</span>
    : <span className="text-success">{t("可升级到")} {check.latest}</span>;
}

/** 通道切换 + 两个自动更新开关 */
export function UpdatePrefsPanel({ state }: { state: ReturnType<typeof useUpdatePrefs> }) {
  const t = useT();
  const { prefs, busy, err, save } = state;
  if (!prefs) return err ? <div className="mt-3 text-xs text-error">{err}</div> : null;
  const chan = (c: UpdateChannel, label: string) => (
    <button
      className={`btn btn-xs join-item ${prefs.channel === c ? "btn-primary" : "btn-ghost bg-base-100"}`}
      disabled={busy || prefs.channel === c}
      onClick={() => void save({ channel: c })}
    >
      {label}
    </button>
  );
  const toggle = (k: "claudestra" | "claudeCode", label: string, hint: string) => (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="text-xs">
        {label}
        <span className="block text-[11px] leading-relaxed text-base-content/50">{hint}</span>
      </span>
      <input type="checkbox" className="toggle toggle-sm shrink-0" checked={prefs[k]} disabled={busy} onChange={() => void save({ [k]: !prefs[k] })} />
    </label>
  );
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-base-content/10 pt-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs">{t("更新通道")}</span>
          <div className="join">{chan("release", t("正式版"))}{chan("beta", "Beta")}</div>
        </div>
        <span className="text-[11px] leading-relaxed text-base-content/50">
          {prefs.channel === "beta"
            ? t("Beta：跟着 main 的每个提交，修复来得最快，但没经过发版验证。")
            : t("正式版：只升到 GitHub 上正式发布的版本（推荐）。")}
        </span>
      </div>
      {toggle("claudestra", t("自动升级 Claudestra"), t("每 30 分钟检查一次，所有 agent 都空闲时才升；关掉后只提醒不升级。"))}
      {toggle("claudeCode", t("自动升级 Claude Code"), t("每周检查一次，同样只在所有 agent 都空闲时才升。"))}
      {err && <div className="text-xs text-error">{err}</div>}
    </div>
  );
}

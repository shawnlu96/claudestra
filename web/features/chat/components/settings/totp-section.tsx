"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/**
 * TOTP 两步验证板块（登录安全第二期）。三态：未启用 → enroll（二维码+验码）
 * → 已启用。恢复码只在生成那一刻展示一次，用户必须自己存下来——这套系统没有
 * 第二个管理员能帮忙重置，认证器丢了没恢复码就是永久失联。
 */
export function TotpSection() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () =>
    fetch("/api/auth/totp")
      .then((r) => r.json())
      .then((j: { enabled?: boolean; recoveryRemaining?: number }) => {
        setEnabled(!!j.enabled);
        setRemaining(j.recoveryRemaining ?? 0);
      })
      .catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const post = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error || "操作失败"); return null; }
      return j;
    } catch {
      setMsg("网络错误");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const j = await post("begin");
    if (j) { setEnroll({ secret: j.secret, uri: j.uri, qrSvg: j.qrSvg }); setCode(""); }
  };
  const finish = async () => {
    const j = await post("complete", { code });
    if (j) { setEnroll(null); setCodes(j.recoveryCodes); await refresh(); }
  };
  const turnOff = async () => {
    if (!confirm(t("关闭两步验证？恢复码也会一并作废。"))) return;
    if (await post("disable")) { setCodes(null); await refresh(); }
  };
  const regen = async () => {
    const j = await post("regen");
    if (j) { setCodes(j.recoveryCodes); await refresh(); }
  };

  return (
    <Section
      title={t("两步验证")}
      aside={
        enabled ? (
          <button className="btn btn-sm btn-ghost text-error" disabled={busy} onClick={() => void turnOff()}>
            {t("关闭")}
          </button>
        ) : enroll ? null : (
          <button className="btn btn-sm" disabled={busy} onClick={() => void start()}>
            {t("启用")}
          </button>
        )
      }
      desc={t("登录时除密码外再要一个认证器 App 的 6 位动态码。不启用则与现在完全一样。")}
    >
      {msg && <div className="mb-2 text-xs text-error">{t(msg)}</div>}

      {/* enroll 中：二维码 + 手输 secret + 验一次码 */}
      {enroll && (
        <div className="space-y-3">
          <div className="text-xs text-base-content/60">
            {t("用认证器 App（1Password / Authy / Google Authenticator 等）扫码，然后填入它显示的 6 位数字。")}
          </div>
          <div
            className="mx-auto w-40 rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: enroll.qrSvg }}
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-base-content/60">{t("扫不了？手动输入密钥")}</summary>
            <code className="mt-1 block break-all rounded bg-base-300/60 p-2 font-mono text-[11px]">
              {enroll.secret}
            </code>
          </details>
          <div className="flex gap-2">
            <input
              className="input input-bordered input-sm flex-1 font-mono tracking-widest"
              inputMode="numeric"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn btn-sm btn-primary" disabled={busy || code.length < 6} onClick={() => void finish()}>
              {t("验证并启用")}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEnroll(null)}>
              {t("取消")}
            </button>
          </div>
        </div>
      )}

      {/* 恢复码：仅生成那一刻展示一次 */}
      {codes && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div className="text-xs font-semibold text-warning">
            {t("⚠️ 恢复码只显示这一次，请立刻保存到密码管理器")}
          </div>
          <div className="grid grid-cols-2 gap-1 font-mono text-[12.5px]">
            {codes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-xs"
              onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => setMsg("已复制"))}
            >
              {t("复制全部")}
            </button>
            <button className="btn btn-xs btn-ghost" onClick={() => setCodes(null)}>{t("我已保存")}</button>
          </div>
        </div>
      )}

      {enabled && !codes && (
        <div className="flex items-center justify-between text-xs text-base-content/60">
          <span>{t("已启用 · 剩余恢复码")} {remaining}</span>
          <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => void regen()}>
            {t("重新生成恢复码")}
          </button>
        </div>
      )}
    </Section>
  );
}

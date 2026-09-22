"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/**
 * Passkey 板块（登录安全第三期）。指纹/面容免密登录——三期里唯一不可钓鱼、
 * 不可爆破的因素，且体验是负成本（比打密码快）。
 *
 * ⚠️ rpID 约束：WebAuthn 凭据绑定域名且不可跨域。这套 web 有多个入口
 * （claude.example.com / Tailscale MagicDNS / localhost），每个域要各注册
 * 一个；明文 IP 入口浏览器根本不给 API，此时 supported=false 不展示注册。
 */
export function PasskeySection() {
  const t = useT();
  const [supported, setSupported] = useState(false);
  const [rpID, setRpID] = useState<string | null>(null);
  const [creds, setCreds] = useState<
    { id: string; name: string; rpID: string; createdAt: string; lastUsedAt: string | null; usableHere: boolean }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () =>
    fetch("/api/auth/passkey")
      .then((r) => r.json())
      .then((j) => {
        setSupported(!!j.supported && typeof window !== "undefined" && !!window.PublicKeyCredential);
        setRpID(j.rpID ?? null);
        setCreds(j.credentials ?? []);
      })
      .catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const register = async () => {
    setBusy(true);
    setMsg("");
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const b = await fetch("/api/auth/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin" }),
      });
      const bj = await b.json();
      if (!b.ok) { setMsg(bj.error || "无法开始注册"); return; }
      const att = await startRegistration({ optionsJSON: bj.options });
      // 默认名带上设备线索，多设备时能分清是哪台
      const guess = /iPhone|iPad/i.test(navigator.userAgent)
        ? "iPhone"
        : /Mac/i.test(navigator.userAgent) ? "Mac" : "这台设备";
      const f = await fetch("/api/auth/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish", challengeId: bj.challengeId, response: att, name: guess }),
      });
      const fj = await f.json();
      if (!f.ok) { setMsg(fj.error || "注册失败"); return; }
      setMsg("已添加");
      await refresh();
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/NotAllowed|abort/i.test(m)) setMsg(m || "注册失败"); // 用户取消不报错
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(t(`删除 Passkey「${name}」？该设备将无法再免密登录。`))) return;
    setBusy(true);
    await fetch("/api/auth/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    }).catch(() => {});
    setBusy(false);
    await refresh();
  };

  return (
    <Section
      title={t("登录安全 · Passkey")}
      aside={
        supported ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => void register()}>
            {t("添加")}
          </button>
        ) : null
      }
      desc={t("用指纹 / 面容代替密码登录。不可钓鱼、不可爆破，而且比打密码快。凭据绑定当前域名，换入口需各加一个。")}
    >
      {msg && <div className="mb-2 text-xs text-base-content/60">{t(msg)}</div>}
      {!supported && (
        <div className="text-xs text-base-content/50">
          {t("当前访问地址不支持 Passkey——需要 HTTPS 域名或 localhost（明文 IP 访问时浏览器不提供该能力）。")}
        </div>
      )}
      {creds.length > 0 && (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {creds.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs">
              <span className="truncate font-medium">{c.name}</span>
              <span className="truncate text-base-content/40">{c.rpID}</span>
              {!c.usableHere && (
                <span className="shrink-0 rounded bg-base-300 px-1.5 py-0.5 text-[10px] text-base-content/50">
                  {t("其它入口")}
                </span>
              )}
              <button
                className="btn btn-ghost btn-xs ml-auto text-error"
                disabled={busy}
                onClick={() => void remove(c.id, c.name)}
              >
                {t("删除")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {supported && creds.length === 0 && (
        <div className="text-xs text-base-content/50">
          {t("还没有 Passkey。点「添加」用本机指纹 / 面容注册一个")}
          {rpID ? `（${rpID}）` : ""}。
        </div>
      )}
    </Section>
  );
}

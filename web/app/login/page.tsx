"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n";

/** 原生表单提交(未水合路径)失败后带回的错误码 → 文案。 */
const FORM_ERRORS: Record<string, string> = {
  cred: "用户名或密码错误",
  rate: "登录尝试过于频繁，请稍后再试",
  empty: "用户名和密码不能为空",
  locked: "尝试失败次数过多，账户已临时锁定，请稍后再试",
  totp: "该账号已启用两步验证，请填写认证器上的 6 位验证码",
  totpbad: "验证码不正确，请检查认证器时间是否同步",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // 两步验证码输入框：服务端说「需要」才出现（没启用 2FA 的人完全看不到）
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  // 未水合的原生提交走 303 重定向回 /login?e=<code>——SSR 也能渲染出错误文案
  const urlErrCode = useSearchParams().get("e") || "";
  const urlError = FORM_ERRORS[urlErrCode] || "";
  // 原生表单路径下服务端要码时也得把输入框亮出来
  const showCode = needTotp || urlErrCode === "totp" || urlErrCode === "totpbad";

  // Passkey 登录（第三期）。仅在当前入口支持 WebAuthn 且该域注册过凭据时出现——
  // 明文 IP 访问下浏览器根本不给 API，展示按钮只会让人点了报错。
  const [passkeyReady, setPasskeyReady] = useState(false);
  useEffect(() => {
    // 只看客户端前提：浏览器支持 + secure context。「这个域有没有注册过凭据」
    // 交给点击时的 begin 返回明确错误，避免每次进登录页都打一发探测请求。
    setPasskeyReady(!!window.PublicKeyCredential && window.isSecureContext === true);
  }, []);

  const loginWithPasskey = async () => {
    setError("");
    setLoading(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const b = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin" }),
      });
      const bj = await b.json();
      if (!b.ok) { setError(bj.error || "Passkey 不可用"); return; }
      const asseResp = await startAuthentication({ optionsJSON: bj.options });
      const f = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish", challengeId: bj.challengeId, response: asseResp }),
      });
      const fj = await f.json();
      if (!f.ok) { setError(fj.error || "Passkey 登录失败"); return; }
      router.push("/");
    } catch (e) {
      // 用户取消指纹弹窗也走这里——不当错误刷屏
      const msg = (e as Error).message || "";
      if (!/NotAllowed|abort/i.test(msg)) setError(msg || "Passkey 登录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, code }),
    });
    const json = await res.json();
    setLoading(false);

    if (!res.ok) {
      if (json.needTotp) setNeedTotp(true); // 亮出验证码输入框
      setError(json.error || "登录失败");
      return;
    }

    // 用掉恢复码时提醒剩余数量——用完了就再也进不来，必须让人有感
    if (json?.data?.recovery?.usedRecovery) {
      try {
        sessionStorage.setItem("cstra_recovery_note", String(json.data.recovery.remaining ?? 0));
      } catch { /* 隐私模式 */ }
    }
    router.push("/");
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 px-4">
      <div className="card w-full max-w-sm bg-base-100 shadow-lg">
        <div className="card-body">
          <h1 className="text-xl font-bold text-center mb-1">Claudestra</h1>
          <p className="text-xs text-center text-base-content/60 mb-4">
            {t("本机 SSH 账号登录")}
          </p>

          {/* action/method：JS 未就绪(冷启动水合慢/失败)时走原生表单 POST——
              服务端认表单编码,成功 303 → /chat,失败 303 → /login?e=<code>。
              水合后 onSubmit preventDefault 走 fetch(错误就地显示不刷页)。
              绝不能让登录依赖水合(2026-07-14「按钮一直转圈」教训)。 */}
          <form
            onSubmit={handleSubmit}
            method="post"
            action="/api/auth/login"
            className="space-y-3"
          >
            <label className="form-control">
              <span className="label-text text-sm mb-1">{t("账号")}</span>
              <input
                type="text"
                name="username"
                className="input input-bordered input-sm w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </label>
            <label className="form-control">
              <span className="label-text text-sm mb-1">{t("密码")}</span>
              <input
                type="password"
                name="password"
                className="input input-bordered input-sm w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>

            {/* 两步验证码：服务端要码时才出现。恢复码也从这里输（一次性，
                认证器丢了时的唯一自救途径）。inputMode=numeric 让手机直接弹数字键盘。 */}
            {showCode && (
              <label className="form-control">
                <span className="label-text text-sm mb-1">{t("两步验证码")}</span>
                <input
                  type="text"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t("6 位验证码，或恢复码")}
                  className="input input-bordered input-sm w-full font-mono tracking-widest"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                />
              </label>
            )}

            {(error || urlError) && (
              <div className="alert alert-error alert-sm text-sm py-2">
                {t(error || urlError)}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-sm w-full"
              disabled={loading}
            >
              {loading ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                t("登录")
              )}
            </button>
          </form>

          {/* Passkey 免密登录（第三期）。放表单外——它不参与原生表单提交路径，
              而且点了要唤起系统指纹弹窗，不能被 form 的 submit 抢走。 */}
          {passkeyReady && (
            <>
              <div className="divider my-3 text-[11px] text-base-content/40">{t("或")}</div>
              <button
                type="button"
                className="btn btn-outline btn-sm w-full gap-2"
                disabled={loading}
                onClick={() => void loginWithPasskey()}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M6 21v-1a6 6 0 0 1 6-6" />
                  <path d="m17 17 4 4" />
                  <circle cx="16" cy="16" r="2" />
                </svg>
                {t("用 Passkey 登录")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

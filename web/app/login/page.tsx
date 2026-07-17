"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n";

/** 原生表单提交(未水合路径)失败后带回的错误码 → 文案。 */
const FORM_ERRORS: Record<string, string> = {
  cred: "用户名或密码错误",
  rate: "登录尝试过于频繁，请稍后再试",
  empty: "用户名和密码不能为空",
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  // 未水合的原生提交走 303 重定向回 /login?e=<code>——SSR 也能渲染出错误文案
  const urlError = FORM_ERRORS[useSearchParams().get("e") || ""] || "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(json.error || "登录失败");
      return;
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
        </div>
      </div>
    </div>
  );
}

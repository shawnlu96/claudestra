"use client";
/**
 * /pair：用一次性配对码把这个浏览器接到这台电脑的 Claudestra。三种进来法（docs/relay/protocol.md §5.2、§6）：
 *   扫电脑终端里的二维码 / 点配对链接 → 地址带 #<code>，页面自动提交；
 *   在中继首页输短码 → 中继 302 到这里，同样带 #；
 *   手动打开 /pair 自己输。
 * 短码只在浏览器里读（# 不上服务器日志）；成功后拿到和密码登录同款的会话。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";

const CODE_CHARS = /[^A-HJ-NP-Z2-9]/g;

/** 用户随手输的 → 8 位大写 + 中间一杠（只保留短码字母表里的字符） */
function formatInput(raw: string): string {
  const s = raw.toUpperCase().replace(CODE_CHARS, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

const compact = (code: string) => code.replace(/-/g, "");

/** 配对后去哪：?next= 只认站内路径（防开放跳转） */
function afterPair(): string {
  const next = new URLSearchParams(window.location.search).get("next") || "";
  return /^\/(?!\/)/.test(next) ? next : "/";
}

function codeFromLocation(): string {
  const hash = window.location.hash.replace(/^#/, "");
  const q = new URLSearchParams(window.location.search).get("code") || "";
  return formatInput(hash || q);
}

export default function PairPage() {
  return (
    <Suspense>
      <PairInner />
    </Suspense>
  );
}

function PairInner() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const autoSubmitted = useRef(false);

  const submit = useCallback(async (value: string) => {
    if (compact(value).length !== 8) {
      setError("配对码是 8 位");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: compact(value) }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string }; // 非 JSON 响应（反代错页）就显示通用的「配对失败」
      if (!res.ok) {
        setError(json.error || "配对失败");
        return;
      }
      router.replace(afterPair());
    } catch {
      setError("网络错误，请重试"); // 请求没发出去或没回来：给用户一句能看懂的话，细节在网络面板里
    } finally {
      setLoading(false);
    }
  }, [router]);

  // 已登录就直接进；地址里带了码就自动提交一次（扫码 / 点链接的人不该再点一下）
  useEffect(() => {
    void fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j: { data?: unknown }) => {
        if (j?.data) router.replace(afterPair());
      })
      .catch(() => {}); // 查不到就照常显示配对表单
    const initial = codeFromLocation();
    if (!initial) return;
    // 地址里的码要等首帧渲染完再填、再提交：effect 里同步 setState 会触发级联重渲染（lint 也拦）
    const timer = setTimeout(() => {
      setCode(initial);
      if (compact(initial).length === 8 && !autoSubmitted.current) {
        autoSubmitted.current = true;
        void submit(initial);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [router, submit]);

  return <PairCard code={code} error={error} loading={loading} onChange={(v) => setCode(formatInput(v))} onSubmit={() => void submit(code)} />;
}

interface CardProps {
  code: string;
  error: string;
  loading: boolean;
  onChange: (raw: string) => void;
  onSubmit: () => void;
}

function PairCard({ code, error, loading, onChange, onSubmit }: CardProps) {
  const t = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 px-4">
      <div className="card w-full max-w-sm bg-base-100 shadow-lg">
        <div className="card-body">
          <h1 className="text-xl font-bold text-center mb-1">Claudestra</h1>
          <p className="text-xs text-center text-base-content/60 mb-4">{t("用配对码把这个浏览器接到你的电脑")}</p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <label className="form-control">
              <span className="label-text text-sm mb-1">{t("配对码")}</span>
              <input
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                className="input input-bordered w-full text-center font-mono text-lg tracking-[0.2em]"
                value={code}
                onChange={(e) => onChange(e.target.value)}
                autoFocus
              />
            </label>
            {error && <div className="alert alert-error alert-sm text-sm py-2">{t(error)}</div>}
            <button type="submit" className="btn btn-primary btn-sm w-full" disabled={loading || compact(code).length !== 8}>
              {loading ? <span className="loading loading-spinner loading-xs" /> : t("配对")}
            </button>
          </form>
          <p className="mt-3 text-[11px] leading-relaxed text-base-content/50">
            {t("在电脑的终端里运行")} <code className="font-mono">claudestra pair</code>
            {t("，会显示二维码、链接和这个 8 位码；10 分钟内有效，只能用一次。")}
          </p>
          <div className="divider my-2 text-[11px] text-base-content/40">{t("或")}</div>
          <Link href="/login" className="btn btn-ghost btn-sm w-full">
            {t("用账号密码登录")}
          </Link>
        </div>
      </div>
    </div>
  );
}

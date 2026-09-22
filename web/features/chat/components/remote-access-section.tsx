"use client";
import { useCallback, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { useT } from "@/lib/i18n";
import { copyText } from "@/features/chat/select-mode";

/**
 * 设置 →「手机访问」：这台机器现在能从手机经哪些地址打开，每个地址能不能用、证书还剩几天。
 *
 * 为什么放在网页里：换入口（明文 IP → HTTPS 域名）要重新注册 Passkey、重装 PWA、重新订阅
 * 推送，所以用户最该在**装 PWA 之前**就看到「主地址是哪个」；证书临期也要在手机上就能看到，
 * 而不是等入口断了才发现。
 *
 * 只读：数据来自 bridge GET /api/v1/remote-access（60 秒缓存）。不放任何「开启 serve」按钮
 * —— 那是改整台机器的网络配置，只在 setup 的交互终端里经用户同意做；这里最多给一条可复制的命令。
 * 独立文件，由设置弹窗挂载（<RemoteAccessSection />）。
 */

interface Entry {
  url: string;
  secure: boolean;
  source: "serve" | "external" | "tailnet-ip";
  reachable: boolean;
  matchesLocal: boolean;
  certDaysLeft?: number;
  certLifetimeDays?: number;
  certValid?: boolean;
}

type Plan =
  | { kind: "not-installed" }
  | { kind: "need-login"; backendState: string; authUrl: string }
  | { kind: "no-magicdns" }
  | { kind: "reuse"; url: string; source: "serve" | "external" }
  | { kind: "need-https-enable"; dnsName: string }
  | { kind: "serve"; port: number; url: string }
  | { kind: "fallback-manual"; reason: string };

interface Snapshot {
  tailscale: { installed: boolean; running: boolean; backendState: string; dnsName: string; httpsEnabled: boolean };
  webPort: number;
  entries: Entry[];
  plan: Plan;
  suggestedCommand: string | null;
  checkedAt: string;
}

/** 与 doctor 同一口径：<7 天红；不到寿命 1/4 黄（CA 在缩短寿命，固定天数会常年误报） */
function certTone(days: number, lifetime = 90): string {
  if (days < 7) return "text-error";
  if (days < lifetime / 4) return "text-warning";
  return "text-base-content/50";
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      className="btn btn-ghost btn-xs border-base-300"
      onClick={() => {
        // 明文 tailnet IP 下不是安全上下文、navigator.clipboard 不存在 —— 恰恰是最需要复制
        // HTTPS 地址的场景，所以走 copyText 的 textarea 兜底；失败也要给反馈而不是装死。
        void copyText(text).then((ok) => {
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1500);
        });
      }}
    >
      {state === "done" ? t("已复制") : state === "failed" ? t("复制失败") : t("复制")}
    </button>
  );
}

function EntryRow({ e }: { e: Entry }) {
  const t = useT();
  const [qr, setQr] = useState(false);
  const usable = e.reachable && e.matchesLocal;
  const sourceLabel =
    e.source === "serve" ? "tailscale serve" : e.source === "external" ? t("外部反代") : t("tailnet IP（明文）");
  return (
    <div className="rounded-lg bg-base-100/70 p-2.5">
      <div className="flex items-center gap-2">
        <span className={`badge badge-sm ${e.secure ? "badge-success" : "badge-ghost"}`}>{e.secure ? "HTTPS" : "HTTP"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.url}>{e.url}</span>
        <CopyButton text={e.url} />
        <button className="btn btn-ghost btn-xs border-base-300" onClick={() => setQr((v) => !v)}>
          {qr ? t("收起") : t("二维码")}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-base-content/50">
        <span>{sourceLabel}</span>
        <span className={usable ? "text-success" : "text-error"}>
          {usable ? t("可用") : e.reachable ? t("通到的不是本机当前的 web") : t("连不上")}
        </span>
        {e.certDaysLeft !== undefined && (
          <span className={certTone(e.certDaysLeft, e.certLifetimeDays)}>
            {e.certDaysLeft < 0
              ? `${t("证书已过期")} ${Math.ceil(-e.certDaysLeft)} ${t("天")}`
              : `${t("证书剩")} ${Math.floor(e.certDaysLeft)} ${t("天")}`}
          </span>
        )}
        {!e.secure && <span>{t("语音输入 / 推送 / Passkey 在明文地址下不可用")}</span>}
      </div>
      {qr && (
        <div
          className="mx-auto mt-2 w-40 rounded bg-white p-1 [&>svg]:h-auto [&>svg]:w-full"
          // uqr 只输出 <path>，不嵌入任何文本；数据是 bridge 探测到的 URL
          dangerouslySetInnerHTML={{ __html: renderSVG(e.url) }}
        />
      )}
    </div>
  );
}

function PlanHint({ snap }: { snap: Snapshot }) {
  const t = useT();
  const p = snap.plan;
  const box = (children: React.ReactNode) => (
    <div className="rounded-lg bg-base-100/70 p-2.5 text-xs leading-relaxed text-base-content/70">{children}</div>
  );
  switch (p.kind) {
    case "reuse":
      return null;
    case "not-installed":
      return box(t("这台电脑还没装 Tailscale。装好并登录后，手机在任何网络下都能用固定地址打开这里。在终端重跑 bun run setup 会一步步引导。"));
    case "need-login":
      return box(
        <>
          {t("Tailscale 已安装但没连上")}（{p.backendState || "?"}）。{t("打开 Tailscale 登录；macOS 首次还要在「系统设置」里允许系统扩展与 VPN 配置。")}
          {p.authUrl && (
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate font-mono">{p.authUrl}</span>
              <CopyButton text={p.authUrl} />
            </div>
          )}
        </>,
      );
    case "no-magicdns":
      return box(t("tailnet 没开 MagicDNS，拿不到 ts.net 域名，也就签不了 HTTPS 证书。去 Tailscale 管理后台的 DNS 页开启。"));
    case "need-https-enable":
      return box(t("tailnet 还没开 HTTPS 证书。去 Tailscale 管理后台 DNS 页开启 HTTPS Certificates（注意：证书会进入公开的证书透明日志，机器名和 tailnet 名可被查到），然后重跑 bun run setup。"));
    case "serve":
      return box(
        <>
          {t("还没有 HTTPS 入口。在这台电脑的终端执行下面这条（只给本 web 加一个 tailnet 内的 HTTPS 入口，不对公网开放），或重跑 bun run setup：")}
          {snap.suggestedCommand && (
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-base-200 px-1.5 py-0.5 font-mono">{snap.suggestedCommand}</code>
              <CopyButton text={snap.suggestedCommand} />
            </div>
          )}
        </>,
      );
    case "fallback-manual":
      return box(t("443 与 8443 都被占用，没法自动配 HTTPS 入口。按 web/SETUP.md 的「证书 + 反代」手工方案配置。"));
  }
}

async function fetchSnapshot(fresh = false): Promise<{ snap?: Snapshot; err?: string }> {
  try {
    const r = await fetch(`/api/remote-access${fresh ? "?fresh=1" : ""}`);
    const j = (await r.json()) as { data?: Snapshot; error?: string };
    if (!r.ok || !j.data) return { err: j.error || `HTTP ${r.status}` };
    return { snap: j.data };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

export function RemoteAccessSection() {
  const t = useT();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [why, setWhy] = useState(false);

  // 异步回调里才 setState：挂载时不同步改状态（react-hooks/set-state-in-effect）
  const apply = useCallback((r: { snap?: Snapshot; err?: string }) => {
    if (r.snap) setSnap(r.snap);
    setErr(r.err ?? "");
    setLoading(false);
  }, []);
  useEffect(() => {
    void fetchSnapshot().then(apply);
  }, [apply]);
  const reload = () => {
    setLoading(true);
    void fetchSnapshot(true).then(apply);
  };

  const ts = snap?.tailscale;
  const badge = !ts
    ? null
    : !ts.installed
      ? { cls: "badge-ghost", text: t("未安装") }
      : !ts.running
        ? { cls: "badge-warning", text: t("未连接") }
        : { cls: "badge-success", text: t("在线") };

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold">
          {t("手机访问")}
          {badge && <span className={`badge badge-sm ${badge.cls}`}>Tailscale · {badge.text}</span>}
        </span>
        <button className="btn btn-ghost btn-sm border-base-300" disabled={loading} onClick={reload}>
          {loading ? t("检测中…") : t("重新检测")}
        </button>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
        {t("手机上用哪个地址打开这里。优先用 HTTPS 地址，并在装到主屏（PWA）之前就用它——换地址要重新注册 Passkey、重装 PWA、重新订阅推送。")}
      </p>
      <div className="mt-3 space-y-2">
        {err && <div className="text-xs text-error">{t("读取失败")}: {err}</div>}
        {snap && snap.entries.map((e) => <EntryRow key={e.url} e={e} />)}
        {snap && ts?.running && snap.entries.length === 0 && (
          <div className="text-xs text-base-content/50">{t("没探测到可用入口")}</div>
        )}
        {snap && <PlanHint snap={snap} />}
        <button className="link link-hover text-[11px] text-base-content/50" onClick={() => setWhy((v) => !v)}>
          {why ? t("收起") : t("为什么需要 HTTPS？")}
        </button>
        {why && (
          <p className="text-[11px] leading-relaxed text-base-content/50">
            {t("浏览器只在安全上下文（HTTPS 或 localhost）里开放麦克风、Service Worker、推送和 Passkey。经 tailnet IP 的明文地址能打开页面，但语音输入、离线/推送、指纹登录都会失效。Tailscale 的 HTTPS 只在你的 tailnet 内可达，不对公网开放。")}
          </p>
        )}
      </div>
    </section>
  );
}

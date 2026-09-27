"use client";
/**
 * Peer 面板顶部的「中继」卡：这台机器在中继上的地址、连接状态，以及网页里直接「配对新设备」（pair-share.tsx，
 * 与设置 · 设备「添加设备」同一张卡），不用开终端跑 claudestra pair。状态来自 /api/v1/relay/status，短码来自 /api/v1/relay/pair。
 * 纯逻辑在 ../relay-card-logic.ts。
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { envSnippet, relayMode, type RelayStatusView } from "../relay-card-logic";
import { CopyButton } from "./peers-shared";
import { PairCodeCard } from "./pair-share";
import { relayStatus } from "@/lib/api/system";
import { newShareCode, type ShareCode } from "@/lib/api/devices";

function OffBlock({ status }: { status: RelayStatusView }) {
  const t = useT();
  const snippet = envSnippet(status.relayUrl, status.slug);
  return (
    <div className="mt-2 space-y-2 text-xs text-base-content/70">
      <p className="leading-relaxed">{t("出门访问目前要靠 Tailscale；在 .env 里加这两行、重启 bridge，手机不装任何东西就能打开这台机器。")}</p>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto rounded-lg bg-base-100 p-2 font-mono text-[11px] leading-relaxed">{snippet}</pre>
        <CopyButton text={snippet} label="复制" />
      </div>
    </div>
  );
}

function OnlineBlock({ status }: { status: RelayStatusView }) {
  const t = useT();
  const [pair, setPair] = useState<ShareCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const newCode = async () => {
    setBusy(true);
    setErr("");
    try {
      setPair(await newShareCode());
    } catch (e) {
      setErr((e as Error).message || t("配对码生成失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-base-content/55">{t("我的中继地址")}</span>
        <a href={status.url ?? "#"} target="_blank" rel="noreferrer" className="link link-hover min-w-0 truncate font-mono text-[12px]">{status.url}</a>
        <CopyButton text={status.url ?? ""} label="复制" />
      </div>
      <p className="leading-relaxed text-base-content/55">{t("手机 / 别的浏览器不装任何东西、不开 Tailscale 就能打开这个地址。")}</p>
      {!pair && (
        <button className="btn btn-primary btn-sm mt-1" disabled={busy} onClick={() => void newCode()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : t("配对新设备")}
        </button>
      )}
      {err && <div className="text-error">{err}</div>}
      {pair && <PairCodeCard key={pair.code} pair={pair} full busy={busy} onAgain={() => void newCode()} />}
    </div>
  );
}

export function RelayCard() {
  const t = useT();
  const [status, setStatus] = useState<RelayStatusView | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      setStatus(await relayStatus<RelayStatusView>());
    } catch {
      setStatus({ ok: false }); // 请求本身失败：卡片显示读不到，30 秒后下一轮再试
    }
  }, []);
  useEffect(() => {
    // 首次拉取放到下一拍：effect 里同步 setState 会触发级联重渲染（lint 也拦）
    const first = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [load]);

  if (status === undefined) return null;
  const mode = relayMode(status);
  const badge =
    mode === "online" ? ["badge-success", t("在线")] : mode === "connecting" ? ["badge-warning", t("连接中")] : mode === "off" ? ["badge-ghost", t("未配置")] : ["badge-ghost", "?"];
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">{t("中继")}</span>
        <span className={`badge badge-xs ${badge[0]}`}>{badge[1]}</span>
        {mode !== "off" && status?.relayUrl && <span className="ml-auto truncate font-mono text-[10.5px] text-base-content/40">{status.relayUrl}</span>}
      </div>
      {mode === "unknown" && <div className="mt-2 text-xs text-error">{t("读取中继状态失败")}{status?.error ? `：${status.error}` : ""}</div>}
      {mode === "off" && status && <OffBlock status={status} />}
      {mode === "connecting" && status && (
        <div className="mt-2 text-xs text-base-content/60">
          {t("没连上")}{status.state ? ` · ${status.state}` : ""}{status.lastError ? ` · ${status.lastError}` : ""}
        </div>
      )}
      {mode === "online" && status && <OnlineBlock status={status} />}
    </section>
  );
}

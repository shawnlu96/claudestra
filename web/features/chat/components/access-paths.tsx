"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { accessPaths, remoteAccess } from "@/lib/api/system";
import { accessRows, type AccessPathsInfo, type EntriesView, type PathRow, type PathState } from "../access-paths-logic";
import { CopyButton } from "./peers-shared";

/**
 * 设置 ·「访问」页顶部：手机连到这台电脑的四条路（中继 / Tailscale / 局域网 / 自己的域名）各自开没开、地址是什么。
 * 讲清它们可以并存、每个地址第一次要配对；怎么开写在每行的说明里。Tailscale 的细节（证书、serve 命令）在下面的 RemoteAccessSection。
 */
const NAME: Record<PathRow["id"], string> = { relay: "中继", tailscale: "Tailscale", lan: "局域网", domain: "自己的域名" };
const PILL: Record<PathState, [string, string]> = { on: ["badge-success", "开着"], partial: ["badge-warning", "没就绪"], off: ["badge-ghost", "没开"] };

export function AccessPathsSection() {
  const t = useT();
  const [info, setInfo] = useState<AccessPathsInfo | null>(null);
  const [snap, setSnap] = useState<EntriesView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    accessPaths<AccessPathsInfo>()
      .then((v) => alive && setInfo(v))
      .catch((e: Error) => alive && setErr(e.message));
    // Tailscale 那半单独失败不影响另外两行：下面的 RemoteAccessSection 会把错误显示出来
    remoteAccess<EntriesView>(false)
      .then((v) => alive && setSnap(v))
      .catch((e: Error) => console.warn("[access] 读 remote-access 失败:", e.message));
    return () => {
      alive = false;
    };
  }, []);
  const rows = accessRows(info, snap);
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="text-[13.5px] font-semibold">{t("手机怎么连到这台电脑")}</div>
      <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
        {t("这几条路可以同时开着，想用哪个用哪个。每个地址第一次打开都要配对一次：设置 · 设备 → 添加设备。")}
      </p>
      {err && <div className="mt-2 text-xs text-error">{t("读取失败")}: {err}</div>}
      {rows.length === 0 && !err && <span className="loading loading-spinner loading-xs mt-3" />}
      <ul className="mt-3 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg bg-base-100/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[13px] font-medium">{t(NAME[r.id])}</span>
              <span className={`badge badge-xs shrink-0 ${PILL[r.state][0]}`}>{t(PILL[r.state][1])}</span>
              {r.url && (
                <span className="ml-auto flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[11px] text-base-content/60">{r.url}</span>
                  <CopyButton text={r.url} label="复制" />
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-base-content/55">{t(r.note)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";

/** Peer 弹窗各面板共用的类型与小组件（从 peers-modal.tsx 原样搬出，只加 export）。 */

export interface LocalAgent {
  name: string;
  external: boolean;
  status: string;
}

export type ActionResult = {
  ok?: boolean;
  error?: string;
  invite?: string;
  receipt?: string;
  warnings?: string[];
  reachable?: boolean;
  remoteAgents?: { name: string; status: string }[];
  // v2.15+ 一键邀请
  expiresAt?: string;
  myUrl?: string;
  peer?: string;
  note?: string;
  exposedAgents?: string[];
  /** join-auto 失败时的下一步说明（src/lib/peer-join-hints.ts） */
  hint?: string;
};

export async function peersAction(body: Record<string, unknown>): Promise<ActionResult> {
  try {
    const res = await fetch("/api/peers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ActionResult;
  } catch {
    return { ok: false, error: "网络错误" };
  }
}

/** scope 勾选器：全部(*) + master + 每个本地 agent。external 未标的带 ⚠。 */
export function ScopePicker({
  localAgents,
  sel,
  onChange,
}: {
  localAgents: LocalAgent[];
  sel: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useT();
  const star = sel.includes("*");
  const toggle = (n: string) =>
    onChange(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
  // master 不提供勾选:服务端硬禁,peer 永远拿不到大总管(owner 2026-07-27)
  const toggleStar = () => onChange(star ? [] : ["*"]);
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-2">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="checkbox checkbox-xs" checked={star} onChange={toggleStar} />
        <span>{t("全部普通 agent（*）")}</span>
        <span className="text-[10px] text-warning">{t("⚠ 不含 master")}</span>
      </label>
      {localAgents.map((a) => (
        <label key={a.name} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={star || sel.includes(a.name)}
            disabled={star}
            onChange={() => toggle(a.name)}
          />
          <span className={a.status === "active" ? "" : "opacity-50"}>{a.name}</span>
          {a.external ? (
            <span className="badge badge-ghost badge-xs">external</span>
          ) : (
            <span className="text-[10px] text-warning">{t("⚠ 未标 external")}</span>
          )}
        </label>
      ))}
    </div>
  );
}

/** 错误/告警行 + 「强制执行」二次确认（服务端 --force / --rotate 提示驱动） */
export function ForceRow({
  msg,
  busy,
  onForce,
  forceLabel,
}: {
  msg: string;
  busy: boolean;
  onForce: () => void;
  forceLabel: string;
}) {
  const t = useT();
  return (
    <div className="mt-2 rounded-lg bg-warning/10 p-2 text-xs">
      <div className="whitespace-pre-wrap break-all text-base-content/80">{msg}</div>
      <button className="btn btn-warning btn-xs mt-2" disabled={busy} onClick={onForce}>
        {t(forceLabel)}
      </button>
    </div>
  );
}

/** 握手串展示 + 复制 */
export function HandshakeString({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg bg-base-100 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t("已复制") : t("复制")}
        </button>
      </div>
      <div className="mt-1 max-h-20 overflow-y-auto break-all font-mono text-[10px] leading-tight text-base-content/70">
        {value}
      </div>
    </div>
  );
}

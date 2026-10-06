"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { peersAction as peersApiAction } from "@/lib/api/system";
export { ScopePicker } from "./peer-scope-picker";

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
  /** 经中继的邀请：bridge 给的可分享链接（中继落地页 /i#邀请码） */
  link?: string;
};

export async function peersAction(body: Record<string, unknown>): Promise<ActionResult> {
  try {
    return await peersApiAction<ActionResult>(body);
  } catch (e) {
    // bridge 的 4xx 语义错误（R1 --force 提示等）message 原样透传给 UI
    return { ok: false, error: (e as Error).message || "网络错误" };
  }
}

/** 「复制 → 已复制」小按钮：Peer 面板里复制邀请 / 地址 / 链接都用它，别再各写一份剪贴板回调 */
export function CopyButton({ text, label, resetMs = 2000 }: { text: string; label: string; resetMs?: number }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-ghost btn-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), resetMs);
        });
      }}
    >
      {copied ? t("已复制") : t(label)}
    </button>
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

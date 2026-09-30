"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { peersAction as peersApiAction } from "@/lib/api/system";
import { setAgentExternal } from "../agent-info";

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

/** scope 勾选器（owner 2026-09-27 闸门化）：external 未开的 agent 不可勾选，点「未开闸」就地确认开闸（开完 onOpened 让调用方重拉
 *  localAgents）；关闸要逐字确认、还要从 peer 的 scope 里摘，仍只在会话详情里做。/join 页没有 chat store，挂不了详情弹窗，
 *  所以开闸不能依赖它。"*" 暂不提供（只有历史 scope 已是 * 时可见可取消）。服务端 lib/peer-scope-gate.ts 是同一条规则的硬闸。 */
export function ScopePicker({
  localAgents,
  sel,
  onChange,
  onOpened,
}: {
  localAgents: LocalAgent[];
  sel: string[];
  onChange: (v: string[]) => void;
  onOpened: () => void;
}) {
  const t = useT();
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const star = sel.includes("*");
  const toggle = (n: string) =>
    onChange(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
  const open = async (name: string) => {
    setBusy(true);
    setErr("");
    const r = await setAgentExternal(name, true);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setArming(null);
    if (!star && !sel.includes(name)) onChange([...sel, name]); // 开闸就是为了勾它
    onOpened();
  };
  // master 不提供勾选:服务端硬禁,peer 永远拿不到大总管(owner 2026-07-27)
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-2">
      <label className={`flex items-center gap-2 text-sm ${star ? "cursor-pointer" : "opacity-50"}`}>
        <input type="checkbox" className="checkbox checkbox-xs" checked={star} disabled={!star} onChange={() => onChange([])} />
        <span>{t("全部普通 agent（*）")}</span>
        <span className="text-[10px] text-base-content/50">{t("暂不提供：请逐个选择已开闸的会话")}</span>
      </label>
      {localAgents.map((a) => {
        const locked = !a.external && !sel.includes(a.name);
        return (
          <div key={a.name}>
            <label className={`flex items-center gap-2 text-sm ${locked || star ? "" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={star || sel.includes(a.name)}
                disabled={star || locked}
                onChange={() => toggle(a.name)}
              />
              <span className={a.status === "active" ? "" : "opacity-50"}>{a.name}</span>
              {a.external ? (
                <span className="badge badge-ghost badge-xs">external</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs h-5 min-h-0 gap-1 px-1.5 text-[10px] text-warning"
                  title={t("开启 external 闸门")}
                  onClick={() => { setErr(""); setArming(arming === a.name ? null : a.name); }}
                >
                  🔒 {t("未开闸")}
                </button>
              )}
            </label>
            {arming === a.name && !a.external && (
              <div className="my-1 ml-5 rounded-md bg-warning/10 p-2 text-[11px] leading-relaxed">
                <div>{t("开启后可共享给 peer；对方能看到该会话的全部上下文。关闭请到会话详情。")}</div>
                {err && <div className="mt-1 text-error">{err}</div>}
                <div className="mt-1.5 flex gap-1.5">
                  <button type="button" className="btn btn-warning btn-xs" disabled={busy} onClick={() => void open(a.name)}>
                    {busy ? "…" : t("开闸")}
                  </button>
                  <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setArming(null)}>
                    {t("取消")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
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

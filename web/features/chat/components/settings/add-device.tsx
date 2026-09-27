"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { newShareCode, type ShareCode } from "@/lib/api/devices";
import { useChatStore } from "../../chat-store";
import { PairCodeCard } from "../pair-share";

/**
 * 设置 · 设备「添加设备」：在手机上直接把这台电脑分享给一台新设备，不用开终端跑 claudestra pair。
 *   我自己的设备 = 全部会话、终端、管理（和 claudestra pair 默认一样；bridge 会按发码设备自己的权限封顶）
 *   给别人      = 独立身份，只含选中的会话；不含大总管、没有终端和管理（claudestra pair --guest）
 * 生成后是 PairCodeCard：扫码 / 链接直接配好，手输短码的就地允许或拒绝。
 */
export function AddDevicePanel({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
  const t = useT();
  const agents = useChatStore((s) => s.state.agents);
  const [who, setWho] = useState<"me" | "guest">("me");
  const [guest, setGuest] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [pair, setPair] = useState<ShareCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const choices = agents.filter((a) => !a.pinnedMaster && !a.mock);

  const issue = async () => {
    if (who === "guest" && !guest.trim()) return setErr(t("写一下是给谁的，比如「Alex 的手机」"));
    if (who === "guest" && picked.length === 0) return setErr(t("至少选一个会话"));
    setBusy(true);
    setErr("");
    try {
      setPair(await newShareCode(who === "guest" ? { guest: guest.trim(), agents: picked } : {}));
    } catch (e) {
      setErr((e as Error).message || t("配对码生成失败"));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string) => setPicked((xs) => (xs.includes(name) ? xs.filter((x) => x !== name) : [...xs, name]));

  if (pair) {
    return (
      <div className="mb-3">
        <PairCodeCard key={pair.code} pair={pair} full={who === "me"} busy={busy} onAgain={() => void issue()} onPaired={onPaired} />
        <button className="btn btn-ghost btn-xs mt-1" onClick={onClose}>
          {t("完成")}
        </button>
      </div>
    );
  }
  const option = (value: "me" | "guest", title: string, desc: string) => (
    <label className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 ${who === value ? "border-primary bg-primary/5" : "border-base-300"}`}>
      <input type="radio" className="radio radio-primary radio-xs mt-0.5" checked={who === value} onChange={() => setWho(value)} />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{title}</span>
        <span className="block text-[11px] leading-relaxed text-base-content/55">{desc}</span>
      </span>
    </label>
  );
  return (
    <div className="mb-3 space-y-2 rounded-lg bg-base-200/60 p-3">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {option("me", t("我自己的设备"), t("全部会话、终端和管理（不会超过你这台设备自己的权限）"))}
        {option("guest", t("给别人"), t("只能用你选的会话；不含大总管，没有终端和管理"))}
      </div>
      {who === "guest" && (
        <div className="space-y-1.5">
          <input
            className="input input-bordered input-sm w-full"
            value={guest}
            maxLength={40}
            placeholder={t("给谁，比如「Alex 的手机」")}
            onChange={(e) => setGuest(e.target.value)}
          />
          <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
            {choices.map((a) => (
              <button
                key={a.name}
                type="button"
                className={`btn btn-xs ${picked.includes(a.name) ? "btn-primary" : "btn-ghost border-base-300"}`}
                onClick={() => toggle(a.name)}
              >
                {a.label || a.displayName}
              </button>
            ))}
          </div>
        </div>
      )}
      {err && <div className="text-xs text-error">{err}</div>}
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("取消")}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void issue()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : t("生成配对码")}
        </button>
      </div>
    </div>
  );
}

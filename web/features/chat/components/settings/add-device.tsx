"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { GUEST_ALL_WARNING, newShareCode, shareCodeErrorText, type ShareCode } from "@/lib/api/devices";
import { useChatStore } from "../../chat-store";
import { PairCodeCard } from "../pair-share";

/**
 * 设置 · 设备「添加设备」：在手机上直接把这台电脑分享给一台新设备，不用开终端跑 claudestra pair。
 *   我自己的设备 = 全部会话、终端、管理（和 claudestra pair 默认一样；bridge 会按发码设备自己的权限封顶）
 *   给别人      = 独立身份，只含选中的会话；不含大总管、没有终端和管理（claudestra pair --guest）。默认一个不勾，没勾不能生成；
 *                 「全部会话」= "*"（以后新建的也算），要再点一次确认（bridge 也要 confirmAllAgents，tests/guest-pairing.test.ts）
 * 生成后是 PairCodeCard：扫码 / 链接直接配好，手输短码的就地允许或拒绝。
 */
const ALL = "*";

/** 「全部会话」和逐个勾选互斥：勾了具体的就退出全部，点全部就清掉具体的 */
function togglePick(xs: string[], name: string): string[] {
  if (xs.includes(name)) return xs.filter((x) => x !== name);
  return name === ALL ? [ALL] : [...xs.filter((x) => x !== ALL), name];
}

/** 「给别人」那一栏：给谁、开放哪些会话（默认一个不勾），选了全部且点过一次生成时亮出提醒 */
function GuestFields({ guest, onGuest, picked, onToggle, choices, armed }: {
  guest: string;
  onGuest: (v: string) => void;
  picked: string[];
  onToggle: (name: string) => void;
  choices: Array<{ name: string; label: string }>;
  armed: boolean;
}) {
  const t = useT();
  const chip = (name: string, label: string) => (
    <button key={name} type="button" className={`btn btn-xs ${picked.includes(name) ? "btn-primary" : "btn-ghost border-base-300"}`} onClick={() => onToggle(name)}>
      {label}
    </button>
  );
  return (
    <div className="space-y-1.5">
      <input
        className="input input-bordered input-sm w-full"
        value={guest}
        maxLength={40}
        placeholder={t("给谁，比如「Alex 的手机」")}
        onChange={(e) => onGuest(e.target.value)}
      />
      <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
        {chip(ALL, t("全部会话（不含大总管）"))}
        {choices.map((c) => chip(c.name, c.label))}
      </div>
      {picked.length === 0 && <div className="text-[11px] text-base-content/50">{t("默认一个都不开放：至少选一个会话")}</div>}
      {armed && (
        <div className="rounded-lg bg-warning/10 px-2.5 py-2 text-xs">
          <span className="block font-medium">{t(GUEST_ALL_WARNING)}</span>
          <span className="block text-base-content/60">{t("只想给几个就逐个勾选；确定要全部就再点一次下面的按钮。")}</span>
        </div>
      )}
    </div>
  );
}

export function AddDevicePanel({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
  const t = useT();
  const agents = useChatStore((s) => s.state.agents);
  const [who, setWho] = useState<"me" | "guest">("me");
  const [guest, setGuest] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [pair, setPair] = useState<ShareCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 选了「全部会话」、点过一次生成：按钮变成「确定开放全部」，再点才签 */
  const [allArmed, setAllArmed] = useState(false);
  const choices = agents.filter((a) => !a.pinnedMaster && !a.mock).map((a) => ({ name: a.name, label: a.label || a.displayName }));
  const all = picked.includes(ALL);
  const blocked = who === "guest" && picked.length === 0;

  /** confirmed：「全部会话」已经确认过（第二次点、或「再来一个」沿用这次的选择） */
  const issue = async (confirmed = false) => {
    if (who === "guest" && !guest.trim()) return setErr(t("写一下是给谁的，比如「Alex 的手机」"));
    if (blocked) return setErr(t("至少选一个会话"));
    if (who === "guest" && all && !confirmed) return setAllArmed(true);
    setBusy(true);
    setErr("");
    try {
      setPair(await newShareCode(who === "guest" ? { guest: guest.trim(), agents: all ? [ALL] : picked, ...(all ? { confirmAllAgents: true } : {}) } : {}));
    } catch (e) {
      setErr(t(shareCodeErrorText(e)));
    } finally {
      setBusy(false);
    }
  };

  if (pair) {
    return (
      <div className="mb-3">
        <PairCodeCard key={pair.code} pair={pair} full={who === "me"} busy={busy} onAgain={() => void issue(true)} onPaired={onPaired} />
        <button className="btn btn-ghost btn-xs mt-1" onClick={onClose}>
          {t("完成")}
        </button>
      </div>
    );
  }
  const pick = (value: "me" | "guest") => {
    setWho(value);
    setAllArmed(false);
  };
  const toggle = (name: string) => {
    setAllArmed(false);
    setPicked((xs) => togglePick(xs, name));
  };
  const option = (value: "me" | "guest", title: string, desc: string) => (
    <label className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 ${who === value ? "border-primary bg-primary/5" : "border-base-300"}`}>
      <input type="radio" className="radio radio-primary radio-xs mt-0.5" checked={who === value} onChange={() => pick(value)} />
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
        <GuestFields
          guest={guest}
          onGuest={setGuest}
          picked={picked}
          onToggle={toggle}
          choices={choices}
          armed={allArmed}
        />
      )}
      {err && <div className="text-xs text-error">{err}</div>}
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("取消")}
        </button>
        <button className={`btn btn-sm ${allArmed ? "btn-warning" : "btn-primary"}`} disabled={busy || blocked} onClick={() => void issue(allArmed)}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : allArmed ? t("确定开放全部") : t("生成配对码")}
        </button>
      </div>
    </div>
  );
}

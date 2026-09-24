"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { JoinConfirm } from "./peers-join-confirm";
import { findInviteCode } from "../invite-link";

/**
 * 「加入对方」：点「粘贴邀请」直接读剪贴板（iOS 会弹系统的「粘贴」气泡），或者手动粘进框里；
 * 认出邀请码就换成加入确认卡（先测连通、列出能找的 agent、可选反向开放，见 peers-join-confirm.tsx）。
 * 贴的是对方发来的整段话、链接还是裸邀请码都行。
 */
export function JoinPanel({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const code = findInviteCode(text);

  const pasteFromClipboard = async () => {
    setErr("");
    try {
      const got = await navigator.clipboard.readText();
      if (findInviteCode(got)) setText(got);
      else setErr(t("剪贴板里没有邀请。先复制对方发来的那段话或链接。"));
    } catch {
      setErr(t("读不了剪贴板，请手动粘贴到下面的框里。")); // 没授权 / 非安全上下文（http）
    }
  };

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-semibold">{t("加入对方")}</span>
        {!code && (
          <button className="btn btn-primary btn-xs" onClick={() => void pasteFromClipboard()}>
            {t("粘贴邀请")}
          </button>
        )}
      </div>
      {code ? (
        <div className="mt-3">
          <JoinConfirm key={code} code={code} onJoined={onChanged} />
          <button className="btn btn-ghost btn-xs mt-2" onClick={() => setText("")}>
            {t("换一个邀请")}
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("或者把对方发来的那段话 / 链接粘贴到这里")}
            rows={2}
            className="textarea textarea-bordered mt-2 w-full text-[12px] leading-tight"
          />
          {err && <div className="mt-1 text-xs text-error">{err}</div>}
          {!!text.trim() && !code && <div className="mt-1 text-xs text-base-content/50">{t("没认出邀请：请复制对方发来的整段话或完整链接")}</div>}
        </>
      )}
    </section>
  );
}

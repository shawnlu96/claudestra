"use client";
/**
 * 被邀请方收邀请（挂在侧栏里，全局一份）：
 * 1. 电脑浏览器 / PWA：还没确认过就提示「允许用这个 Claudestra 打开协作邀请链接」，点允许 = 向浏览器登记
 *    web+claudestra:（邀请落地页的按钮用它跳回这里）。浏览器不告诉我们结果，真从链接进过 /join 才算确认；
 *    之前每隔几天提醒一次（owner 2026-09-24：更新后用户没允许，也要记得弹框让他允许）。
 * 2. 剪贴板：浏览器已授权读剪贴板时，回到前台顺手看一眼，有新邀请就提示；没授权不主动要权限。
 * 3. 在任何地方粘贴带邀请的文字 → 不当成普通文字，直接弹加入确认。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";
import { CenteredModal } from "./centered-modal";
import { JoinConfirm } from "./peers-join-confirm";
import { decodeInvite, findInviteCode } from "../invite-link";
import { firstSeen, INVITE_PROTOCOL, setHandlerState, shouldAskHandler } from "../invite-intake";

const noopSubscribe = () => () => {};
const handlerSupported = () => "registerProtocolHandler" in navigator && !isNativeShell();

export function InviteIntake() {
  const t = useT();
  const supported = useSyncExternalStore(noopSubscribe, handlerSupported, () => false);
  const [hideAsk, setHideAsk] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ask = !hideAsk && shouldAskHandler(supported);

  useEffect(() => {
    const peek = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const st = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
        if (st?.state !== "granted") return; // 不主动要权限：Peer 面板有手动「粘贴邀请」
        const code = findInviteCode(await navigator.clipboard.readText());
        if (code && firstSeen(code)) setFound(code);
      } catch {
        /* 浏览器不支持读剪贴板 / 权限查询：静默，走手动粘贴 */
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const code = findInviteCode(e.clipboardData?.getData("text") || "");
      if (!code) return;
      e.preventDefault(); // 邀请不当普通文字塞进输入框，直接弹确认
      firstSeen(code);
      setOpen(code);
    };
    void peek();
    document.addEventListener("visibilitychange", peek);
    window.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("visibilitychange", peek);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  const allow = () => {
    try {
      navigator.registerProtocolHandler(INVITE_PROTOCOL, `${location.origin}/join?i=%s`);
    } catch (e) {
      console.warn("[invite] 浏览器拒绝登记邀请链接:", e);
    }
    setHandlerState("later"); // 登记结果浏览器不告诉我们：真从链接进过 /join 才标确认，这之前过几天再提醒
    setHideAsk(true);
  };
  const later = () => {
    setHandlerState("later");
    setHideAsk(true);
  };

  if (typeof document === "undefined") return null;
  const name = found ? decodeInvite(found)?.name : "";
  return createPortal(
    <>
      {(ask || found) && (
        <div className="fixed bottom-[max(env(safe-area-inset-bottom),16px)] left-1/2 z-[60] w-[min(92vw,420px)] -translate-x-1/2 space-y-2">
          {found && (
            <Toast text={`${t("检测到")} ${name} ${t("的协作邀请")}`} primary={t("查看")} onPrimary={() => { setOpen(found); setFound(null); }} onClose={() => setFound(null)} />
          )}
          {ask && !found && (
            <Toast
              text={t("允许用这个 Claudestra 打开协作邀请链接？以后别人发来的邀请点一下就能直接到这里确认。")}
              primary={t("允许")}
              onPrimary={allow}
              secondary={t("以后再说")}
              onClose={later}
            />
          )}
        </div>
      )}
      {open && (
        <CenteredModal onClose={() => setOpen(null)}>
          <div className="p-5">
            <JoinConfirm code={open} />
          </div>
        </CenteredModal>
      )}
    </>,
    document.body,
  );
}

function Toast({ text, primary, onPrimary, secondary, onClose }: { text: string; primary: string; onPrimary: () => void; secondary?: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-base-300 bg-base-100 px-3 py-2.5 text-[12.5px] shadow-lg">
      <span className="min-w-0 flex-1 leading-snug">{text}</span>
      <button className="btn btn-primary btn-xs" onClick={onPrimary}>{primary}</button>
      <button className="btn btn-ghost btn-xs" onClick={onClose}>{secondary ?? "✕"}</button>
    </div>
  );
}

"use client";
/**
 * 非图片附件点开（规则在 lib/chat/attachment-open.ts）：文本类在这一层里预览，其他类型手机上交系统分享、桌面下载。
 * 手机上分享被拒（取文件太久、手势过期）时也用这一层给出「文件已就绪」和分享按钮，让用户再点一次，不会点了没反应。
 * 取不到文件就在层里说清楚；不用 window.open 兜底：根相对的 /api/v1 经中继少了机器前缀会 404，新窗口也带不上设备凭据。
 */
import { useMemo, useState } from "react";
import { defaultInlineRules } from "@do-md/core-react";
import { Domd } from "@/components/domd";
import { useT } from "@/lib/i18n";
import { clipPreview, openMode, textFlavor, type TextFlavor } from "@/lib/chat/attachment-open";
import { isNativeShell } from "@/lib/native";
import { shareFile } from "../attachment-share";
import { fetchAuthBlob, saveBlob } from "./auth-img";
import { CenteredModal } from "./centered-modal";
import { CheckIcon, CopyIcon, FileIcon, ShareIcon, XIcon } from "./line-icons";

/** 手机 / 壳：非文本附件走分享而不是下载（壳里 <a download> 没人接） */
function isMobileLike(): boolean {
  if (isNativeShell()) return true;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false; // 没有 matchMedia 的老浏览器按桌面算：照旧下载
  }
}

export type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | { kind: "text"; flavor: TextFlavor; text: string; blob: Blob }
  | { kind: "ready"; blob: Blob };

/**
 * 点开一个附件：文本类先弹层（加载中）再填内容；其他类型取回后分享 / 下载，分享被拒才弹「文件已就绪」。
 * 加载中用户可能已经关了层：迟到的结果照样 show，由调用方丢弃（FileChip 按点开序号比对）。
 */
export async function openAttachment(url: string, name: string, show: (s: PreviewState) => void): Promise<void> {
  if (textFlavor(name)) show({ kind: "loading" });
  let blob: Blob;
  try {
    blob = await fetchAuthBlob(url);
  } catch (e) {
    const m = /attachment (\d+)/.exec((e as Error)?.message || "");
    show({ kind: "error", status: m ? Number(m[1]) : undefined });
    return;
  }
  const mode = openMode(name, blob.type, { mobile: isMobileLike() });
  if (mode === "preview") {
    show({ kind: "text", flavor: textFlavor(name, blob.type)!, text: await blob.text(), blob });
    return;
  }
  if (mode === "share") {
    const r = await shareFile(blob, name);
    if (r === "blocked") show({ kind: "ready", blob });
    if (r !== "unsupported") return;
  }
  saveBlob(blob, name);
}

const iconBtn = "btn btn-ghost btn-sm btn-square text-base-content/70";

/** 分享（系统面板）；不支持分享的桌面浏览器退回下载 */
function useShare(name: string, blob: Blob, text?: string) {
  const [again, setAgain] = useState(false);
  const share = () =>
    void shareFile(blob, name, text).then((r) => {
      if (r === "unsupported") saveBlob(blob, name);
      setAgain(r === "blocked"); // 刚取完就点也可能过期：保留按钮再点一次即可
    });
  return { share, again };
}

function CopyAll({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState<"ok" | "fail" | null>(null);
  const copy = () =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setDone("ok"))
      .catch(() => setDone("fail")) // 没权限（非安全上下文 / 被拒）：按钮提示一下，内容仍可长按选中复制
      .finally(() => setTimeout(() => setDone(null), 2000));
  const label = done === "fail" ? t("复制失败") : done === "ok" ? t("已复制") : t("复制全文");
  return (
    <button type="button" className={iconBtn} onClick={copy} title={label} aria-label={label}>
      {done === "ok" ? <CheckIcon size={16} className="text-success" /> : <CopyIcon size={16} />}
    </button>
  );
}

function ShareButton({ name, blob, text }: { name: string; blob: Blob; text?: string }) {
  const t = useT();
  const { share } = useShare(name, blob, text);
  return (
    <button type="button" className={iconBtn} onClick={share} title={t("分享")} aria-label={t("分享")}>
      <ShareIcon size={16} />
    </button>
  );
}

function TextBody({ flavor, text }: { flavor: TextFlavor; text: string }) {
  const t = useT();
  const { shown, truncated } = useMemo(() => clipPreview(text), [text]);
  return (
    <>
      {truncated && <div className="border-b border-base-300 bg-base-200 px-4 py-1.5 text-xs text-base-content/70">{t("内容过长，仅显示开头")}</div>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {flavor === "markdown" ? (
          // 只留默认行内规则：附件是外来内容，`[[{#id}…]]` 不能变成会替用户回投给 agent 的按钮
          <Domd initMd={shown} inlineRules={defaultInlineRules} bodyClassName="chat-domd px-4 py-3" />
        ) : (
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-base-content">{shown}</pre>
        )}
      </div>
    </>
  );
}

function ReadyBody({ name, blob }: { name: string; blob: Blob }) {
  const t = useT();
  const { share, again } = useShare(name, blob);
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <FileIcon size={32} className="text-base-content/50" />
      <div className="text-sm font-medium text-base-content">{t("文件已就绪")}</div>
      <p className="max-w-xs text-xs text-base-content/70">
        {again ? t("系统没有弹出分享面板，请再点一次。") : t("点下面的按钮，用其他应用打开或存储到文件。")}
      </p>
      <button type="button" className="btn btn-primary btn-sm mt-2 min-w-32 gap-1.5" onClick={share}>
        <ShareIcon size={15} />
        {t("分享")}
      </button>
    </div>
  );
}

function Status({ state }: { state: Extract<PreviewState, { kind: "loading" | "error" }> }) {
  const t = useT();
  const msg =
    state.kind === "loading"
      ? t("加载中…")
      : state.status === 404
        ? t("附件取不到了，可能已经被清理。")
        : t("附件加载失败，请稍后再试。");
  return <div className={`px-6 py-10 text-center text-sm ${state.kind === "error" ? "text-error" : "text-base-content/60"}`}>{msg}</div>;
}

export function AttachmentPreview({ name, state, onClose }: { name: string; state: PreviewState; onClose: () => void }) {
  const t = useT();
  return (
    <CenteredModal onClose={onClose} wide={state.kind === "text"}>
      <div className="flex shrink-0 items-center gap-1 border-b border-base-300 py-1.5 pl-4 pr-2">
        <FileIcon size={15} className="shrink-0 text-base-content/50" />
        <div className="ml-1 min-w-0 flex-1 truncate text-sm font-medium text-base-content" title={name}>
          {name}
        </div>
        {state.kind === "text" && <CopyAll text={state.text} />}
        {state.kind === "text" && <ShareButton name={name} blob={state.blob} text={state.text} />}
        <button type="button" className={iconBtn} onClick={onClose} title={t("关闭")} aria-label={t("关闭")}>
          <XIcon size={18} />
        </button>
      </div>
      {state.kind === "text" ? (
        <TextBody flavor={state.flavor} text={state.text} />
      ) : state.kind === "ready" ? (
        <ReadyBody name={name} blob={state.blob} />
      ) : (
        <Status state={state} />
      )}
    </CenteredModal>
  );
}

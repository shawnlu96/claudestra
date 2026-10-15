/**
 * Composer 的附件入口：选择文件与粘贴共用，先过归一化（attachment-normalize.ts）再进待发列表；
 * 拦下的给一条提示（带同一行诊断文字，提示条「详情」展开）。每次粘贴 console.info 一行 [paste-diag]。
 */
import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { NO_CONTENT_HINT, TOO_LARGE_HINT, normalizeAttachment } from "./attachment-normalize";
import { formatPasteDiag, readClipboard, type ClipboardRead } from "./attachment-normalize-paste";

export interface AttachNotice {
  hint: string;
  params?: Record<string, string>;
  diag: string;
}

interface PasteSource {
  types: string[];
  items: { kind: string; type: string }[];
  clip: ClipboardRead;
}

interface IntakeOpts {
  disabled: boolean;
  max: number;
  taRef: RefObject<HTMLTextAreaElement | null>;
  setFiles: Dispatch<SetStateAction<File[]>>;
}

function pasteHint(src: PasteSource | null): Omit<AttachNotice, "diag"> | null {
  if (src?.clip.missing) return { hint: NO_CONTENT_HINT };
  if (src?.clip.html.tooLarge) return { hint: TOO_LARGE_HINT, params: { name: "pasted" } };
  return null;
}

/** 焦点在别的输入框（搜索 / 弹窗）时不劫持它的粘贴 */
function focusedOtherInput(ta: HTMLTextAreaElement | null): boolean {
  const ae = document.activeElement;
  return !!ae && ae !== ta && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae as HTMLElement).isContentEditable);
}

export function useAttachmentIntake(opts: IntakeOpts) {
  const [notice, setNotice] = useState<AttachNotice | null>(null);
  const { max, taRef, setFiles } = opts; // 都是稳定引用 / 常量：粘贴监听里的旧闭包读到的也是同一份

  const intake = async (picked: File[], src: PasteSource | null) => {
    const results = await Promise.all(picked.map(normalizeAttachment));
    const html = src?.clip.html ?? { refused: 0, tooLarge: 0 };
    const diag = formatPasteDiag({
      types: src?.types ?? ["(pick)"], items: src?.items ?? [], files: results.map((r) => r.diag),
      html: { fromHtml: src?.clip.fromHtml ?? 0, refused: html.refused, tooLarge: html.tooLarge },
    });
    if (src) console.info(diag);
    const ok = results.flatMap((r) => (r.ok ? [r.file] : []));
    if (ok.length) setFiles((prev) => [...prev, ...ok].slice(0, max));
    const bad = results.find((r) => !r.ok);
    const hint = bad && !bad.ok ? { hint: bad.hint, params: bad.params } : pasteHint(src);
    setNotice(hint ? { ...hint, diag } : null);
  };

  // 窗口级监听：桌面端焦点常常不在输入框（刚点完消息 / 侧栏），Ctrl+V 也要能收。
  // 纯文字粘贴不拦，照常进输入框；剪贴板 HTML 只用来取内嵌 data: 图片，从不插进输入框
  useEffect(() => {
    if (opts.disabled) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      // DataTransfer 只在事件里可读：类型和条目先同步拍下来
      const src: PasteSource = { types: [...dt.types], items: Array.from(dt.items, (i) => ({ kind: i.kind, type: i.type })), clip: readClipboard(dt) };
      if (!src.clip.files.length && !src.clip.missing && !src.clip.html.tooLarge) {
        console.info(formatPasteDiag({ types: src.types, items: src.items, files: [], html: { fromHtml: 0, refused: src.clip.html.refused, tooLarge: src.clip.html.tooLarge } }));
        return;
      }
      if (focusedOtherInput(taRef.current)) return;
      e.preventDefault();
      void intake(src.clip.files, src);
      taRef.current?.focus();
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [opts.disabled]); // eslint-disable-line react-hooks/exhaustive-deps -- intake 只用稳定引用（见上），不必跟着重挂

  return { addFiles: (picked: File[]) => void (picked.length && intake(picked, null)), notice, dismissNotice: () => setNotice(null) };
}

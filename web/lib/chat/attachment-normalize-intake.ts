/**
 * Composer 的附件入口：选择文件与粘贴共用，先过归一化（attachment-normalize.ts）再进待发列表；
 * 拦下的给一条提示（带同一行诊断文字，提示条「详情」展开）。每次粘贴 console.info 一行 [paste-diag]。
 */
import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { formatPasteDiag, readClipboard } from "./attachment-normalize-paste";
import { AttachmentIntake, type AttachNotice, type PasteSource } from "./attachment-normalize-queue";

interface IntakeOpts {
  disabled: boolean;
  max: number;
  taRef: RefObject<HTMLTextAreaElement | null>;
  setFiles: Dispatch<SetStateAction<File[]>>;
}

/** 焦点在别的输入框（搜索 / 弹窗）时不劫持它的粘贴 */
function focusedOtherInput(ta: HTMLTextAreaElement | null): boolean {
  const ae = document.activeElement;
  return !!ae && ae !== ta && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae as HTMLElement).isContentEditable);
}

export function useAttachmentIntake(opts: IntakeOpts) {
  const [notice, setNotice] = useState<AttachNotice | null>(null);
  const { max, taRef, setFiles } = opts; // 都是稳定引用 / 常量：只建一次的 core 和粘贴监听里的旧闭包读到的也是同一份
  const [core] = useState(
    () => new AttachmentIntake({ addFiles: (ok) => setFiles((prev) => [...prev, ...ok].slice(0, max)), setNotice, log: (l) => console.info(l) }),
  );
  const intake = (picked: File[], src: PasteSource | null) => core.run(picked, src);

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

  /** 切会话 / 发送后清空待发列表：一并作废在途的归一化（attachment-normalize-queue.ts） */
  const clearFiles = () => {
    core.invalidate();
    setFiles([]);
    setNotice(null);
  };
  return { addFiles: (picked: File[]) => void (picked.length && intake(picked, null)), clearFiles, notice, dismissNotice: () => setNotice(null) };
}

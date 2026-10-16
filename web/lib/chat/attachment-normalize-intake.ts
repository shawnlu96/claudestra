/**
 * Composer 的附件入口：选择文件与粘贴共用，先过归一化（attachment-normalize.ts）再进待发列表；
 * 拦下的给一条提示（带同一行诊断文字，提示条「详情」展开）。每次粘贴记一行 [paste-diag]：console + bridge 的 client.log。
 */
import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { postClientLog } from "@/lib/client-log";
import { AttachmentIntake, handlePaste, type AttachNotice, type PasteSource } from "./attachment-normalize-queue";

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

/** 诊断行同时打 console 和回传 bridge 的 client.log（owner 机器上的 console 我们看不到） */
function pasteLog(line: string): void {
  console.info(line);
  postClientLog(line);
}

export function useAttachmentIntake(opts: IntakeOpts) {
  const [notice, setNotice] = useState<AttachNotice | null>(null);
  const { max, taRef, setFiles } = opts; // 都是稳定引用 / 常量：只建一次的 core 和粘贴监听里的旧闭包读到的也是同一份
  const [core] = useState(
    () => new AttachmentIntake({ addFiles: (ok) => setFiles((prev) => [...prev, ...ok].slice(0, max)), setNotice, log: pasteLog }),
  );
  const intake = (picked: File[], src: PasteSource | null) => core.run(picked, src);

  // 窗口级监听：桌面端焦点常常不在输入框（刚点完消息 / 侧栏），Ctrl+V 也要能收。
  // 纯文字粘贴不拦，照常进输入框；剪贴板 HTML 只用来取内嵌 data: 图片，从不插进输入框
  useEffect(() => {
    if (opts.disabled) return;
    const ctx = { intake: core, log: pasteLog, otherInputFocused: () => focusedOtherInput(taRef.current), focusComposer: () => taRef.current?.focus() };
    const onWindowPaste = (e: ClipboardEvent) => void handlePaste(e, ctx);
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

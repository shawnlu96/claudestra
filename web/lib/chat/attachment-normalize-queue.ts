/**
 * 附件入口的异步部分（不依赖 React，hook 只做接线）：归一化要读文件，读完才写回待发列表。
 * 切会话 / 发送清空时 invalidate()，在途的结果作废——否则 A 会话里粘的图读完后会落进 B 会话的输入框，
 * 下一次发送就发错人（tests/web-attachment-normalize.test.ts「代次」用例）。
 */
import { NO_CONTENT_HINT, TOO_LARGE_HINT, normalizeAttachment } from "./attachment-normalize";
import { formatPasteDiag, readClipboard, type ClipboardLike, type ClipboardRead } from "./attachment-normalize-paste";
import type { ReadDeps } from "./attachment-normalize-read";

export interface AttachNotice {
  hint: string;
  params?: Record<string, string>;
  diag: string;
}

export interface PasteSource {
  types: string[];
  items: { kind: string; type: string }[];
  clip: ClipboardRead;
}

export interface IntakeSink {
  addFiles(files: File[]): void;
  setNotice(n: AttachNotice | null): void;
  log(line: string): void;
}

function pasteHint(src: PasteSource | null): Omit<AttachNotice, "diag"> | null {
  if (src?.clip.missing) return { hint: NO_CONTENT_HINT };
  if (src?.clip.html.tooLarge) return { hint: TOO_LARGE_HINT, params: { name: "pasted" } };
  return null;
}

export class AttachmentIntake {
  private gen = 0;
  constructor(
    private readonly sink: IntakeSink,
    private readonly deps?: ReadDeps,
  ) {}

  /** 切会话 / 发送清空：在途的归一化作废，结果和提示都不再写回 */
  invalidate(): void {
    this.gen++;
  }

  async run(picked: File[], src: PasteSource | null): Promise<void> {
    const gen = this.gen;
    // map 在第一个 await 之前跑完：每个文件的第一种读法（FileReader）都在 paste 回调里同步发起
    const results = await Promise.all(picked.map((f) => normalizeAttachment(f, this.deps)));
    const html = src?.clip.html ?? { refused: 0, tooLarge: 0 };
    const diag = formatPasteDiag({
      types: src?.types ?? ["(pick)"], items: src?.items ?? [], files: results.map((r) => r.diag),
      html: { fromHtml: src?.clip.fromHtml ?? 0, refused: html.refused, tooLarge: html.tooLarge },
    });
    if (src) this.sink.log(diag); // 诊断属于这次粘贴本身，作废了也照记
    if (gen !== this.gen) return;
    // 一好一坏：能读的照收，提示只针对读不出的那个
    const ok = results.flatMap((r) => (r.ok ? [r.file] : []));
    if (ok.length) this.sink.addFiles(ok);
    const bad = results.find((r) => !r.ok);
    const hint = bad && !bad.ok ? { hint: bad.hint, params: bad.params } : pasteHint(src);
    this.sink.setNotice(hint ? { ...hint, diag } : null);
  }
}

/** window paste 监听的全部逻辑（hook 只挂监听）：每次粘贴恰好记一行诊断，读取在回调里同步发起 */
export interface PasteHandlerCtx {
  intake: AttachmentIntake;
  /** 一次粘贴一行诊断：console + 回传 client.log（hook 里接 postClientLog） */
  log(line: string): void;
  /** 焦点在别的输入框（搜索 / 弹窗）时不劫持它的粘贴 */
  otherInputFocused(): boolean;
  focusComposer(): void;
}

export function handlePaste(e: { clipboardData: ClipboardLike | null; preventDefault(): void }, ctx: PasteHandlerCtx): Promise<void> | null {
  const dt = e.clipboardData;
  if (!dt) return null;
  // DataTransfer 只在事件里可读：类型和条目先同步拍下来
  const src: PasteSource = { types: [...dt.types], items: Array.from(dt.items, (i) => ({ kind: i.kind, type: i.type })), clip: readClipboard(dt) };
  // 不收附件的粘贴（纯文字 / 焦点在别的输入框）也记一行，诊断只含类型不含内容；收附件的由 run() 记
  const passThrough = !src.clip.files.length && !src.clip.missing && !src.clip.html.tooLarge;
  if (passThrough || ctx.otherInputFocused()) {
    const html = { fromHtml: 0, refused: src.clip.html.refused, tooLarge: src.clip.html.tooLarge };
    ctx.log(formatPasteDiag({ types: src.types, items: src.items, files: [], html }));
    return null;
  }
  e.preventDefault();
  const pending = ctx.intake.run(src.clip.files, src);
  ctx.focusComposer();
  return pending;
}

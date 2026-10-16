/**
 * 附件入口的异步部分（不依赖 React，hook 只做接线）：归一化要读文件，读完才写回待发列表。
 * 切会话 / 发送清空时 invalidate()，在途的结果作废——否则 A 会话里粘的图读完后会落进 B 会话的输入框，
 * 下一次发送就发错人（tests/web-attachment-normalize.test.ts「代次」用例）。
 */
import { NO_CONTENT_HINT, TOO_LARGE_HINT, normalizeAttachment } from "./attachment-normalize";
import { formatPasteDiag, type ClipboardRead } from "./attachment-normalize-paste";

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
  constructor(private readonly sink: IntakeSink) {}

  /** 切会话 / 发送清空：在途的归一化作废，结果和提示都不再写回 */
  invalidate(): void {
    this.gen++;
  }

  async run(picked: File[], src: PasteSource | null): Promise<void> {
    const gen = this.gen;
    const results = await Promise.all(picked.map(normalizeAttachment));
    const html = src?.clip.html ?? { refused: 0, tooLarge: 0 };
    const diag = formatPasteDiag({
      types: src?.types ?? ["(pick)"], items: src?.items ?? [], files: results.map((r) => r.diag),
      html: { fromHtml: src?.clip.fromHtml ?? 0, refused: html.refused, tooLarge: html.tooLarge },
    });
    if (src) this.sink.log(diag); // 诊断属于这次粘贴本身，作废了也照记
    if (gen !== this.gen) return;
    const ok = results.flatMap((r) => (r.ok ? [r.file] : []));
    if (ok.length) this.sink.addFiles(ok);
    const bad = results.find((r) => !r.ok);
    const hint = bad && !bad.ok ? { hint: bad.hint, params: bad.params } : pasteHint(src);
    this.sink.setNotice(hint ? { ...hint, diag } : null);
  }
}

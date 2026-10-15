/**
 * 粘贴的剪贴板兜底与诊断行（纯函数，composer 经 attachment-normalize-intake.ts 调用）。
 * files 为空时只认 text/html 里 <img src="data:image/…;base64,…">；file:// / http(s):// 一律不抓取，
 * 剪贴板 HTML 也不进输入框——抓本地路径或远程地址等于替网页读用户没选的文件（tests/web-attachment-normalize.test.ts）。
 */
import { MAX_ATTACHMENT_BYTES, sniffHead, type FileDiag } from "./attachment-normalize";

export interface HtmlImages {
  files: File[];
  /** 不是 base64 data URL 的 <img>（file:// / http(s):// / 其它）：不抓取，算没拿到内容 */
  refused: number;
  tooLarge: number;
}

const IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const DATA_IMG = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i;

function decodeBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null; // 非法 base64：调用方按拒收计，提示「没拿到文件内容」
  }
}

/** 从剪贴板 HTML 里取内嵌图片；data URL 超过上限的不解码 */
export function imagesFromHtml(html: string): HtmlImages {
  const out: HtmlImages = { files: [], refused: 0, tooLarge: 0 };
  for (const m of html.matchAll(IMG_SRC)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const data = DATA_IMG.exec(src);
    if (!data) {
      out.refused++;
      continue;
    }
    if (Math.floor((data[2].replace(/\s+/g, "").length * 3) / 4) > MAX_ATTACHMENT_BYTES) {
      out.tooLarge++;
      continue;
    }
    const bytes = decodeBase64(data[2]);
    if (!bytes?.length) {
      out.refused++;
      continue;
    }
    const sniff = sniffHead(bytes);
    const type = sniff?.mime ?? data[1].toLowerCase();
    const ext = sniff?.ext ?? (type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "img");
    out.files.push(new File([bytes as BlobPart], `pasted.${ext}`, { type }));
  }
  return out;
}

/** ClipboardEvent.clipboardData 里用得到的部分（测试可直接造） */
export interface ClipboardLike {
  types: readonly string[];
  items: ArrayLike<{ kind: string; type: string }>;
  files: ArrayLike<File>;
  getData(type: string): string;
}

export interface ClipboardRead {
  files: File[];
  /** 从 HTML 兜底出来的文件数 */
  fromHtml: number;
  /** 剪贴板里明明有文件 / 图片，却一个都拿不到：该给「另存为」提示 */
  missing: boolean;
  html: HtmlImages;
}

/** 一次粘贴要收的附件。有正文的富文本粘贴（网页选段带图）当普通文字粘贴，不劫持 */
export function readClipboard(dt: ClipboardLike): ClipboardRead {
  const files = Array.from(dt.files);
  const none: HtmlImages = { files: [], refused: 0, tooLarge: 0 };
  if (files.length) return { files, fromHtml: 0, missing: false, html: none };
  const hasFileItem = Array.from(dt.items).some((i) => i.kind === "file");
  const text = dt.types.includes("text/plain") ? dt.getData("text/plain").trim() : "";
  const html = !text && dt.types.includes("text/html") ? imagesFromHtml(dt.getData("text/html")) : none;
  const missing = html.files.length === 0 && (hasFileItem || html.refused > 0);
  return { files: html.files, fromHtml: html.files.length, missing, html };
}

/** 一行 [paste-diag]：只记 types、items 的 kind/type、每个文件的 type/size/嗅探/可读，不记文件名、路径、HTML、内容 */
export function formatPasteDiag(o: {
  types: readonly string[];
  items: ArrayLike<{ kind: string; type: string }>;
  files: FileDiag[];
  html: { fromHtml: number; refused: number; tooLarge: number };
}): string {
  const items = Array.from(o.items, (i) => `${i.kind}:${i.type || "-"}`).join(",");
  const files = o.files.map((f) => `${f.type || "-"}/${f.size}/${f.sniff ?? "?"}/${f.readable ? "readable" : "unreadable"}`).join(",");
  const html = `${o.html.fromHtml}/refused${o.html.refused}/big${o.html.tooLarge}`;
  return `[paste-diag] types=${o.types.join(",")} items=${items} files=${files} html-img=${html}`;
}

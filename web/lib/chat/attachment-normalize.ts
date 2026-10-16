/**
 * 附件进待发列表前的归一化：读文件头嗅探类型，补正空 / 不符的 MIME 和缺的扩展名；
 * 拿不到内容（0 字节、读取抛错）和超限的在前端就拦下，给一句能照做的提示。
 * 微信 Mac 版复制的图片 / 文件交给 Chrome 时常是 type 为空、无扩展名、空壳引用或 TIFF（tests/web-attachment-normalize.test.ts）。
 */

import { readAllBytes, readState, type ReadDeps, type ReadState } from "./attachment-normalize-read";

/** 与 bridge 入站上传上限一致（src/bridge/api-routes.ts 的 10MB 检查） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const NO_CONTENT_HINT = "没拿到文件内容。微信里的图片 / 文件请先『另存为』，再拖进来或点回形针选择。";
export const TOO_LARGE_HINT = "文件「{name}」超过 10MB，发不出去";

export interface Sniff {
  mime: string;
  ext: string;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** 认文件头（前 32 字节够用）：PNG / JPEG / GIF / WebP / HEIC / TIFF / PDF，其它返回 null */
export function sniffHead(b: Uint8Array): Sniff | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (ascii(b, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(b, 8, 4))) return { mime: "image/heic", ext: "heic" };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0]) || startsWith(b, [0x4d, 0x4d, 0, 0x2a])) return { mime: "image/tiff", ext: "tiff" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  return null;
}

/** Chrome 解不了的图片类型：不转码，按文件发 */
const UNDECODABLE = new Set(["image/tiff", "image/heic", "image/heif"]);

/** 待发缩略图和发出后的气泡共用这一个判断：能在浏览器里解码的图片才按图片显示 */
export function isPreviewableImage(type: string): boolean {
  const t = type.toLowerCase();
  return t.startsWith("image/") && !UNDECODABLE.has(t);
}

export type AttachmentDecision =
  | { ok: true; name: string; type: string; sniff: Sniff | null }
  | { ok: false; reason: "empty" | "unreadable" | "too_large"; hint: string; params?: Record<string, string> };

/** 纯判定。head = 文件前 32 字节；null = 读取抛错 */
export function decideAttachment(meta: { name: string; type: string; size: number }, head: Uint8Array | null): AttachmentDecision {
  if (meta.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large", hint: TOO_LARGE_HINT, params: { name: meta.name } };
  if (head === null) return { ok: false, reason: "unreadable", hint: NO_CONTENT_HINT };
  if (meta.size === 0 || head.length === 0) return { ok: false, reason: "empty", hint: NO_CONTENT_HINT };
  const sniff = sniffHead(head);
  let name = meta.name || "pasted";
  if (sniff && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name = `${name}.${sniff.ext}`;
  return { ok: true, name, type: sniff && meta.type.toLowerCase() !== sniff.mime ? sniff.mime : meta.type, sniff };
}

/** 诊断行里一个文件的样子：只有类型 / 大小 / 嗅探 / 可读状态，不含文件名和内容 */
export interface FileDiag {
  type: string;
  size: number;
  sniff: string | null;
  readable: ReadState;
}

export type Normalized =
  | { ok: true; file: File; diag: FileDiag }
  | { ok: false; reason: "empty" | "unreadable" | "too_large"; hint: string; params?: Record<string, string>; diag: FileDiag };

/**
 * 读整份字节（attachment-normalize-read.ts 的四种读法）+ 判定；收下的一律是用读出的字节新建的 File——
 * 原 File 读不通时（微信）上传那一步也会再读失败。读取在第一个 await 之前发起，paste 回调同步调进来就同步开读。
 */
export async function normalizeAttachment(f: File, deps?: ReadDeps): Promise<Normalized> {
  const inRange = f.size > 0 && f.size <= MAX_ATTACHMENT_BYTES;
  const read = inRange ? await readAllBytes(f, deps) : null;
  const bytes = read?.ok ? new Uint8Array(read.bytes) : null;
  const readable: ReadState = read ? readState(read) : f.size === 0 ? "empty" : "untested";
  const d = decideAttachment({ name: f.name, type: f.type, size: f.size }, inRange ? bytes?.subarray(0, 32) ?? null : new Uint8Array());
  const diag: FileDiag = { type: f.type, size: f.size, sniff: d.ok ? d.sniff?.mime ?? null : null, readable };
  if (!d.ok) return { ...d, diag };
  return { ok: true, file: new File([bytes!.buffer as ArrayBuffer], d.name, { type: d.type, lastModified: f.lastModified }), diag };
}

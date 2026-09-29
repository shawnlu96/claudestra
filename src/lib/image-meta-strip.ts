/**
 * 人与人之间传的图片（talk 附件、human 节点交付附图）落盘前去掉元数据：EXIF（含 GPS、机型、拍摄时间）、XMP、IPTC、
 * 文本注释。类型只按文件头认，只收 png / jpeg / webp；SVG（能带脚本）、GIF、HEIC 一律拒，扩展名和 Content-Type 都不算数。
 * 做法是按容器格式逐段拷贝、只留白名单里的段，不重新编码，所以像素不变、也不引图像库。
 * JPEG 的方向（EXIF Orientation）是显示所需而不是隐私，改成只含这一项的最小 EXIF 写回，否则手机竖拍的照片会横过来。
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export type StripResult = { ok: true; mime: ImageMime; data: Uint8Array } | { ok: false; reason: "unsupported" | "corrupt" };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Uint8Array, at: number, len: number): string => String.fromCharCode(...b.subarray(at, at + len));
const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

export function sniffImage(b: Uint8Array): ImageMime | null {
  if (startsWith(b, PNG_SIG)) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

export function stripImageMeta(input: Uint8Array): StripResult {
  const mime = sniffImage(input);
  if (!mime) return { ok: false, reason: "unsupported" };
  const data = mime === "image/png" ? stripPng(input) : mime === "image/jpeg" ? stripJpeg(input) : stripWebp(input);
  return data ? { ok: true, mime, data } : { ok: false, reason: "corrupt" };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── PNG：chunk = 长度(4 BE) + 类型(4) + 数据 + CRC(4)。整块拷贝，CRC 不用重算 ──

/** 关键块 + 只描述像素怎么显示的辅助块（色彩、透明、动画）；tEXt / zTXt / iTXt / eXIf / tIME 和私有块都不在里面 */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCv", "cLLi", "bKGD", "hIST", "pHYs", "sPLT", "acTL", "fcTL", "fdAT"]);

function stripPng(b: Uint8Array): Uint8Array | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  let first = true;
  while (at + 12 <= b.length) {
    const len = view.getUint32(at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (end > b.length || (first && type !== "IHDR")) return null;
    first = false;
    if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end));
    if (type === "IEND") return concat(parts); // IEND 之后的尾巴（常见的是拼上去的别的文件）一并丢掉
    at = end;
  }
  return null;
}

// ── WebP：RIFF 容器，chunk = FourCC + 大小(4 LE) + 数据 + 奇数长度补 1 字节 ──

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
/** VP8X 标志字节里的 EXIF、XMP 两位：块删了，标志也得清，否则解码器会去找不存在的块 */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(b: Uint8Array): Uint8Array | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > b.length) return null;
  const parts: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const type = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > riffEnd) return null;
    if (WEBP_KEEP.has(type)) {
      const chunk = b.slice(at, Math.min(end, riffEnd));
      if (type === "VP8X" && size >= 1) chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      parts.push(chunk);
    }
    at = end;
  }
  if (!parts.length) return null;
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return concat([head, body]);
}

// ── JPEG：段 = FF + 标记 + 长度(2 BE，含自身) + 数据；SOS 之后是熵编码数据，直到下一个非填充、非 RST 的标记 ──

const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

/** APPn 与 COM 是元数据的藏身处；只留 JFIF（APP0）、ICC 色彩（APP2 ICC_PROFILE）和 Adobe（APP14，影响 CMYK / YCCK 的色彩转换） */
function keepJpegSegment(marker: number, b: Uint8Array, dataAt: number, dataLen: number): boolean {
  if (marker === COM) return false;
  if (marker < 0xe0 || marker > 0xef) return true;
  if (marker === 0xe0 || marker === APP14) return true;
  if (marker === APP2) return dataLen >= 12 && ascii(b, dataAt, 12) === "ICC_PROFILE\0";
  return false;
}

/** 从 APP1 的 Exif 里读 IFD0 的 Orientation（0x0112）；读不到或是默认的 1 返回 null */
export function exifOrientation(b: Uint8Array, dataAt: number, dataLen: number): number | null {
  if (dataLen < 14 || ascii(b, dataAt, 6) !== "Exif\0\0") return null;
  const tiff = dataAt + 6;
  const tiffEnd = dataAt + dataLen;
  const order = ascii(b, tiff, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => view.getUint16(at, le);
  const ifd = tiff + view.getUint32(tiff + 4, le);
  if (ifd + 2 > tiffEnd) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiffEnd) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 2 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** 只含 Orientation 一项的 APP1：Exif 头 + 大端 TIFF 头 + 一个条目的 IFD0 + 下一个 IFD 偏移 0 */
function orientationApp1(v: number): Uint8Array {
  const seg = new Uint8Array(36);
  const d = new DataView(seg.buffer);
  seg.set([0xff, APP1]);
  d.setUint16(2, 34);
  seg.set([...new TextEncoder().encode("Exif"), 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], 4);
  d.setUint16(18, 1);
  d.setUint16(20, 0x0112);
  d.setUint16(22, 3);
  d.setUint32(24, 1);
  d.setUint16(28, v);
  return seg;
}

/** SOS 段之后的熵编码数据：跳过 FF00 填充和 RST0–7，返回下一个真正标记的 FF 位置 */
function scanEntropy(b: Uint8Array, at: number): number | null {
  for (let i = at; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const m = b[i + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) continue;
    return i;
  }
  return null;
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let orientationDone = false;
  let at = 2;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return null;
    let m = b[at + 1];
    while (m === 0xff && at + 2 < b.length) m = b[++at + 1]; // 标记前允许多个 FF 填充
    if (m === EOI) {
      parts.push(new Uint8Array([0xff, EOI])); // EOI 之后（如 iPhone 的 MPF 附图，自带 EXIF）不要
      return concat(parts);
    }
    if (at + 4 > b.length) return null;
    const len = (b[at + 2] << 8) | b[at + 3];
    const end = at + 2 + len;
    if (len < 2 || end > b.length) return null;
    if (keepJpegSegment(m, b, at + 4, len - 2)) parts.push(b.subarray(at, end));
    else if (m === APP1 && !orientationDone) {
      const v = exifOrientation(b, at + 4, len - 2);
      if (v !== null) {
        parts.push(orientationApp1(v));
        orientationDone = true;
      }
    }
    if (m !== SOS) {
      at = end;
      continue;
    }
    const next = scanEntropy(b, end);
    if (next === null) return null;
    parts.push(b.subarray(end, next));
    at = next;
  }
  return null;
}

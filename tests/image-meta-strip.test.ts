import { describe, expect, test } from "bun:test";
import { exifOrientation, sniffImage, stripImageMeta } from "../src/lib/image-meta-strip.js";

const enc = (s: string): number[] => [...new TextEncoder().encode(s)];
const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number): number[] => u32be(n).reverse();
const has = (b: Uint8Array, s: string): boolean => Buffer.from(b).includes(Buffer.from(s));
const ok = (b: Uint8Array) => {
  const r = stripImageMeta(b);
  if (!r.ok) throw new Error(`strip 失败：${r.reason}`);
  return r;
};

function pngChunk(type: string, data: number[]): number[] {
  const body = [...enc(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(Bun.hash.crc32(new Uint8Array(body)))];
}
const IHDR = pngChunk("IHDR", [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0]);
const IDAT = pngChunk("IDAT", [...Bun.deflateSync(new Uint8Array([0, 255, 0, 0]))]);
const IEND = pngChunk("IEND", []);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jpegSeg(marker: number, data: number[]): number[] {
  return [0xff, marker, ((data.length + 2) >> 8) & 255, (data.length + 2) & 255, ...data];
}
/** Exif APP1 数据：大端，IFD0 两项——Orientation 和一个带 GPS 字样的 ImageDescription（ASCII，内联不下所以指向偏移 38） */
function exifData(orientation: number, le = false): number[] {
  const u16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n: number) => (le ? u32le(n) : u32be(n));
  const desc = enc("GPS 31.2304N 121.4737E\0");
  return [
    ...enc("Exif"), 0, 0, ...enc(le ? "II" : "MM"), ...u16(42), ...u32(8), ...u16(2),
    ...u16(0x010e), ...u16(2), ...u32(desc.length), ...u32(38),
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u32(0), ...desc,
  ];
}
const SOS_AND_DATA = [...jpegSeg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56];
function jpeg(...segs: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...jpegSeg(0xe0, [...enc("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...segs.flat(), ...jpegSeg(0xdb, new Array(65).fill(1)), ...SOS_AND_DATA, 0xff, 0xd9]);
}

function webp(chunks: [string, number[]][]): Uint8Array {
  const body = chunks.flatMap(([t, d]) => [...enc(t), ...u32le(d.length), ...d, ...(d.length & 1 ? [0] : [])]);
  return new Uint8Array([...enc("RIFF"), ...u32le(body.length + 4), ...enc("WEBP"), ...body]);
}

describe("sniffImage：只认文件头", () => {
  test("png / jpeg / webp", () => {
    expect(sniffImage(new Uint8Array([...PNG_SIG, ...IHDR]))).toBe("image/png");
    expect(sniffImage(jpeg())).toBe("image/jpeg");
    expect(sniffImage(webp([["VP8L", [1, 2, 3]]]))).toBe("image/webp");
  });
  test("SVG、GIF、HEIC、空的一律拒", () => {
    for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "<?xml version='1.0'?><svg/>", "GIF89a....", "\0\0\0\x18ftypheic"]) {
      expect(stripImageMeta(new Uint8Array(enc(s)))).toEqual({ ok: false, reason: "unsupported" });
    }
    expect(stripImageMeta(new Uint8Array())).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("PNG", () => {
  const withMeta = new Uint8Array([
    ...PNG_SIG, ...IHDR, ...pngChunk("tEXt", enc("Author\0someone")), ...pngChunk("eXIf", exifData(6)), ...pngChunk("tIME", [7, 234, 9, 29, 1, 2, 3]),
    ...pngChunk("sRGB", [0]), ...IDAT, ...pngChunk("iTXt", enc("XML:com.adobe.xmp\0\0\0\0\0<x/>")), ...IEND, ...enc("trailing junk"),
  ]);
  test("去掉文本、eXIf、tIME 和 IEND 之后的尾巴，保留像素相关块，字节与原块一致", () => {
    const r = ok(withMeta);
    expect(r.mime).toBe("image/png");
    expect(Buffer.from(r.data).equals(Buffer.from([...PNG_SIG, ...IHDR, ...pngChunk("sRGB", [0]), ...IDAT, ...IEND]))).toBe(true);
  });
  test("干净的 PNG 原样返回", () => {
    const clean = new Uint8Array([...PNG_SIG, ...IHDR, ...IDAT, ...IEND]);
    expect(Buffer.from(ok(clean).data).equals(Buffer.from(clean))).toBe(true);
  });
  test("截断、第一块不是 IHDR、没有 IEND 都算坏图", () => {
    expect(stripImageMeta(withMeta.subarray(0, 40))).toEqual({ ok: false, reason: "corrupt" });
    expect(stripImageMeta(new Uint8Array([...PNG_SIG, ...IDAT, ...IHDR, ...IEND]))).toEqual({ ok: false, reason: "corrupt" });
    expect(stripImageMeta(new Uint8Array([...PNG_SIG, ...IHDR, ...IDAT]))).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("JPEG", () => {
  test("EXIF（含 GPS 字样）、XMP、IPTC、注释、MPF 都去掉；方向改写成只含 Orientation 的最小 EXIF", () => {
    const src = jpeg(
      jpegSeg(0xe1, exifData(6)),
      jpegSeg(0xe1, [...enc("http://ns.adobe.com/xap/1.0/\0"), ...enc("<x:xmpmeta>GPS</x:xmpmeta>")]),
      jpegSeg(0xed, enc("Photoshop 3.0\0IPTC by someone")),
      jpegSeg(0xe2, enc("MPF\0\0\0\0\0")),
      jpegSeg(0xe2, [...enc("ICC_PROFILE\0"), 1, 1, 9, 9]),
      jpegSeg(0xfe, enc("comment: taken at home")),
    );
    const r = ok(src);
    for (const s of ["GPS", "xmpmeta", "IPTC", "MPF", "comment"]) expect(has(r.data, s)).toBe(false);
    expect(has(r.data, "ICC_PROFILE")).toBe(true);
    expect(has(r.data, "JFIF")).toBe(true);
    const app1 = Buffer.from(r.data).indexOf(Buffer.from([0xff, 0xe1]));
    expect(exifOrientation(r.data, app1 + 4, 32)).toBe(6);
    expect([...r.data.subarray(-9)]).toEqual([0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56, 0xff, 0xd9]);
  });
  test("小端 EXIF 的方向也读得到；方向为 1 就不写 EXIF", () => {
    expect(has(ok(jpeg(jpegSeg(0xe1, exifData(8, true)))).data, "Exif")).toBe(true);
    expect(has(ok(jpeg(jpegSeg(0xe1, exifData(1)))).data, "Exif")).toBe(false);
  });
  test("EOI 之后拼上的附图（自带 EXIF）不要", () => {
    const src = new Uint8Array([...jpeg(), 0xff, 0xd8, ...jpegSeg(0xe1, exifData(3)), 0xff, 0xd9]);
    const r = ok(src);
    expect(has(r.data, "GPS")).toBe(false);
    expect([...r.data.subarray(-2)]).toEqual([0xff, 0xd9]);
  });
  test("段长越界、没有 EOI 算坏图", () => {
    expect(stripImageMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))).toEqual({ ok: false, reason: "corrupt" });
    const noEoi = jpeg().subarray(0, -2);
    expect(stripImageMeta(noEoi)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("WebP", () => {
  test("去掉 EXIF / XMP 块和未知块，清掉 VP8X 的对应标志，RIFF 长度重算", () => {
    const src = webp([["VP8X", [0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ["ICCP", [1, 2, 3]], ["VP8L", [9, 9, 9, 9]], ["EXIF", exifData(6)], ["XMP ", enc("<x>GPS</x>")], ["ZZZZ", enc("private")]]);
    const r = ok(src);
    expect(r.mime).toBe("image/webp");
    for (const s of ["EXIF", "XMP ", "GPS", "ZZZZ"]) expect(has(r.data, s)).toBe(false);
    const view = new DataView(r.data.buffer, r.data.byteOffset);
    expect(view.getUint32(4, true)).toBe(r.data.length - 8);
    expect(r.data[20]).toBe(0x20); // 0x2c 清掉 EXIF(0x08) 与 XMP(0x04)，ICC(0x20) 留着
    expect(has(r.data, "ICCP")).toBe(true);
  });
  test("奇数长度块的补齐字节保留，RIFF 声明的长度超出文件算坏图", () => {
    const r = ok(webp([["VP8 ", [1, 2, 3]]]));
    expect(r.data.length).toBe(12 + 8 + 4);
    const bad = webp([["VP8 ", [1, 2, 3, 4]]]);
    new DataView(bad.buffer).setUint32(4, 999, true);
    expect(stripImageMeta(bad)).toEqual({ ok: false, reason: "corrupt" });
  });
});

/**
 * WXPASTE1：附件进待发列表前的归一化（web/lib/chat/attachment-normalize.ts）与剪贴板兜底 / 诊断行
 * （web/lib/chat/attachment-normalize-paste.ts）。微信 Mac 版复制的图片 / 文件到 Chrome 可能是 type 为空、无扩展名、
 * 0 字节、读不出或 TIFF——这里把这几种都按字节造出来。
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_ATTACHMENT_BYTES, NO_CONTENT_HINT, decideAttachment, isPreviewableImage, normalizeAttachment, sniffHead,
} from "@/lib/chat/attachment-normalize";
import { formatPasteDiag, imagesFromHtml, readClipboard } from "@/lib/chat/attachment-normalize-paste";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46];
const GIF = [...Buffer.from("GIF89a"), 1, 0, 1, 0];
const WEBP = [...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
const TIFF = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0];
const TIFF_BE = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8];
const HEIC = [0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")];
const PDF = [...Buffer.from("%PDF-1.7\n")];
const bytes = (a: number[]) => new Uint8Array(a);
const file = (a: number[], name: string, type = "") => new File([bytes(a)], name, { type });

/** 读文件头会抛错的 File（微信缓存里的文件引用失效 / 无权限时 Chrome 的表现） */
function unreadable(name: string, size: number, type = ""): File {
  const f = new File([new Uint8Array(size)], name, { type });
  const boom = () => Promise.reject(new DOMException("A requested file or directory could not be found", "NotReadableError"));
  Object.defineProperty(f, "slice", { value: () => ({ arrayBuffer: boom }) });
  Object.defineProperty(f, "arrayBuffer", { value: boom });
  return f;
}

describe("[验收线 1] sniffHead：读前 32 字节认类型", () => {
  test("PNG / JPEG / GIF / WebP 可预览；HEIC / TIFF 认出来但不可预览；PDF 不是图片", () => {
    expect(sniffHead(bytes(PNG))).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffHead(bytes(JPEG))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffHead(bytes(GIF))).toEqual({ mime: "image/gif", ext: "gif" });
    expect(sniffHead(bytes(WEBP))).toEqual({ mime: "image/webp", ext: "webp" });
    expect(sniffHead(bytes(TIFF))).toEqual({ mime: "image/tiff", ext: "tiff" });
    expect(sniffHead(bytes(TIFF_BE))).toEqual({ mime: "image/tiff", ext: "tiff" });
    expect(sniffHead(bytes(HEIC))).toEqual({ mime: "image/heic", ext: "heic" });
    expect(sniffHead(bytes(PDF))).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(sniffHead(bytes([...Buffer.from("hello world")]))).toBeNull();
    expect(sniffHead(bytes([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]))).toBeNull();
  });
  test("isPreviewableImage：浏览器能解码的才当图片；TIFF / HEIC / HEIF 按文件", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]) expect(isPreviewableImage(t)).toBe(true);
    for (const t of ["image/tiff", "image/heic", "image/heif", "IMAGE/TIFF", "application/pdf", ""]) expect(isPreviewableImage(t)).toBe(false);
  });
});

describe("[验收线 1] decideAttachment / normalizeAttachment", () => {
  test("type 为空、无扩展名的 PNG / JPEG / GIF / WebP → 补正 MIME 和扩展名", async () => {
    const cases: [number[], string, string][] = [[PNG, "image/png", "图片.png"], [JPEG, "image/jpeg", "图片.jpg"], [GIF, "image/gif", "图片.gif"], [WEBP, "image/webp", "图片.webp"]];
    for (const [head, mime, name] of cases) {
      const r = await normalizeAttachment(file(head, "图片"));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.file.type).toBe(mime);
      expect(r.file.name).toBe(name);
      expect(r.file.size).toBe(head.length);
      expect(isPreviewableImage(r.file.type)).toBe(true);
    }
  });
  test("声明的 type 与嗅探不符 → 以嗅探为准；已有扩展名不改名；认不出的类型原样保留", async () => {
    const r = await normalizeAttachment(file(TIFF, "微信图片.png", "image/png"));
    expect(r.ok && [r.file.type, r.file.name]).toEqual(["image/tiff", "微信图片.png"]);
    const doc = file([...Buffer.from("PK\x03\x04abc")], "报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const d = await normalizeAttachment(doc);
    expect(d.ok && d.file).toBe(doc); // 不需要改就是原 File，不复制
    const shot = file(PNG, "Screenshot.png", "image/png");
    const s = await normalizeAttachment(shot);
    expect(s.ok && s.file).toBe(shot); // 系统截图（PNG）照旧
  });
  test("TIFF / HEIC 嗅探出来但标为不可预览（会作为文件发送）", async () => {
    for (const [head, mime] of [[TIFF, "image/tiff"], [HEIC, "image/heic"]] as const) {
      const r = await normalizeAttachment(file([...head], "image"));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.file.type).toBe(mime);
      expect(r.diag.sniff).toBe(mime);
      expect(isPreviewableImage(r.file.type)).toBe(false);
    }
  });
  test("0 字节 → 拒绝，给「没拿到文件内容」提示", async () => {
    const r = await normalizeAttachment(new File([], "image.png", { type: "image/png" }));
    expect(r).toMatchObject({ ok: false, reason: "empty", hint: NO_CONTENT_HINT });
    expect(NO_CONTENT_HINT).toContain("另存为");
  });
  test("读取抛错（文件引用失效 / 权限）→ 拒绝，同一条提示；诊断记 readable=false", async () => {
    const r = await normalizeAttachment(unreadable("x", 2048, "image/png"));
    expect(r).toMatchObject({ ok: false, reason: "unreadable", hint: NO_CONTENT_HINT });
    expect(r.diag).toEqual({ type: "image/png", size: 2048, sniff: null, readable: false });
  });
  test(">10 MiB → 拒绝（不读内容），提示带文件名和 10MB；恰好 10 MiB 放行", async () => {
    const big = decideAttachment({ name: "大图.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 }, null);
    expect(big).toMatchObject({ ok: false, reason: "too_large", params: { name: "大图.png" } });
    expect(!big.ok && big.hint).toContain("10MB");
    expect(decideAttachment({ name: "ok.png", type: "", size: MAX_ATTACHMENT_BYTES }, bytes(PNG))).toMatchObject({ ok: true, type: "image/png" });
    const r = await normalizeAttachment(unreadable("巨大", MAX_ATTACHMENT_BYTES + 5));
    expect(r).toMatchObject({ ok: false, reason: "too_large" }); // 先看大小：读不出也报超限，不报「没拿到」
  });
  test("size 声称非零但读出 0 字节 → 当作没拿到内容", () => {
    expect(decideAttachment({ name: "a", type: "", size: 10 }, new Uint8Array())).toMatchObject({ ok: false, reason: "empty" });
  });
  test("没有文件名 → 用 pasted 加嗅探扩展名", () => {
    expect(decideAttachment({ name: "", type: "", size: 16 }, bytes(PNG))).toMatchObject({ ok: true, name: "pasted.png", type: "image/png" });
  });
});

const b64 = (a: number[]) => Buffer.from(a).toString("base64");

describe("[验收线 2] 剪贴板兜底：files 为空时看 text/html 里的 <img>", () => {
  test("只有 text/html <img src=\"data:image/png;base64,…\"> → 产出一个 PNG File", async () => {
    const r = imagesFromHtml(`<meta charset="utf-8"><img src="data:image/png;base64,${b64(PNG)}" alt="x">`);
    expect(r.refused).toBe(0);
    expect(r.files.length).toBe(1);
    const f = r.files[0];
    expect([f.type, f.name, f.size]).toEqual(["image/png", "pasted.png", PNG.length]);
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes(PNG));
  });
  test("src 是 file:// 或 http(s):// → 不抓取、不产文件，记为拒收", () => {
    for (const src of ["file:///Users/x/Library/Containers/com.tencent.xinWeChat/a.jpg", "https://example.com/a.png", "http://x/y.gif"]) {
      expect(imagesFromHtml(`<img src='${src}'>`)).toEqual({ files: [], refused: 1, tooLarge: 0 });
    }
  });
  test("data URL 超过 10 MiB → 不解码，记超限；非 base64 的 data: 也拒收", () => {
    const huge = "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8);
    expect(imagesFromHtml(`<img src="data:image/png;base64,${huge}">`)).toEqual({ files: [], refused: 0, tooLarge: 1 });
    expect(imagesFromHtml(`<img src="data:image/svg+xml,%3Csvg%3E">`).refused).toBe(1);
    expect(imagesFromHtml(`<img src="data:image/png;base64,@@@">`).refused).toBe(1);
  });
  test("没有 <img> 的 HTML → 什么都不做", () => {
    expect(imagesFromHtml("<b>hello</b>")).toEqual({ files: [], refused: 0, tooLarge: 0 });
  });
  test("readClipboard：有文件就只用文件；只有 html 图片时才兜底；带正文的富文本粘贴不劫持", () => {
    const png = file(PNG, "a.png", "image/png");
    const html = `<img src="data:image/png;base64,${b64(PNG)}">`;
    const dt = (o: { files?: File[]; html?: string; text?: string; items?: { kind: string; type: string }[] }) => ({
      types: [...(o.files?.length ? ["Files"] : []), ...(o.html ? ["text/html"] : []), ...(o.text ? ["text/plain"] : [])],
      items: o.items ?? [],
      files: o.files ?? [],
      getData: (t: string) => (t === "text/html" ? o.html ?? "" : t === "text/plain" ? o.text ?? "" : ""),
    });
    expect(readClipboard(dt({ files: [png], html }))).toMatchObject({ files: [png], fromHtml: 0, missing: false });
    expect(readClipboard(dt({ html }))).toMatchObject({ fromHtml: 1, missing: false });
    expect(readClipboard(dt({ html: "<img src=\"file:///a.jpg\">" }))).toMatchObject({ files: [], missing: true });
    expect(readClipboard(dt({ html: "<p>看这段<img src=\"https://x/a.png\"></p>", text: "看这段" }))).toMatchObject({ files: [], missing: false });
    expect(readClipboard(dt({ text: "纯文字" }))).toMatchObject({ files: [], missing: false });
    // 有文件条目但 files 为空：浏览器没把内容交给网页
    expect(readClipboard(dt({ items: [{ kind: "file", type: "image/tiff" }] }))).toMatchObject({ files: [], missing: true });
  });
});

describe("[验收线 1] 诊断行只记类型 / 大小 / 嗅探 / 可读", () => {
  test("不含文件名、路径、HTML、内容", async () => {
    const r = await normalizeAttachment(file(PNG, "私密名字", ""));
    const line = formatPasteDiag({
      types: ["Files", "text/html"], items: [{ kind: "file", type: "" }, { kind: "string", type: "text/html" }],
      files: [r.diag, { type: "", size: 3, sniff: null, readable: false }], html: { fromHtml: 0, refused: 1, tooLarge: 0 },
    });
    expect(line.startsWith("[paste-diag] ")).toBe(true);
    expect(line).toContain("types=Files,text/html");
    expect(line).toContain("items=file:-,string:text/html");
    expect(line).toContain("files=-/16/image/png/readable,-/3/?/unreadable");
    expect(line).toContain("html-img=0/refused1/big0");
    expect(line).not.toContain("私密名字");
    expect(line).not.toMatch(/file:\/\/|https?:|<img|base64/);
  });
});

/**
 * T37 手机端点开附件：文本类应用内预览、其他类型手机分享 / 桌面下载（web/lib/chat/attachment-open.ts），
 * 分享结果分类（web/features/chat/attachment-share.ts：手势过期 → blocked，让用户在「文件已就绪」层里再点一次）。
 */
import { describe, expect, test } from "bun:test";
import { PREVIEW_LIMIT, clipPreview, openMode, textFlavor } from "@/lib/chat/attachment-open";
import { shareFile, type ShareNav } from "@/features/chat/attachment-share";

describe("textFlavor：附件是不是文本、怎么渲染", () => {
  test("按扩展名：md 走 domd，其他文本等宽，大小写不敏感", () => {
    expect(textFlavor("设计稿.md")).toBe("markdown");
    expect(textFlavor("README.MARKDOWN")).toBe("markdown");
    for (const n of ["a.txt", "run.log", "x.json", "t.csv", "c.yaml", "diff.patch", "main.ts", "build.sh"]) expect(textFlavor(n)).toBe("plain");
  });
  test("html 按源码文本显示（等宽），不是 markdown、不渲染", () => {
    expect(textFlavor("page.html")).toBe("plain");
    expect(textFlavor("noext", "text/html")).toBe("plain");
  });
  test("svg / 图片 / 二进制不算文本", () => {
    expect(textFlavor("logo.svg")).toBeNull();
    expect(textFlavor("logo.svg", "image/svg+xml")).toBeNull();
    expect(textFlavor("a.pdf", "application/pdf")).toBeNull();
    expect(textFlavor("a.zip")).toBeNull();
    expect(textFlavor("blob", "application/octet-stream")).toBeNull();
  });
  test("扩展名认不出时看 MIME（带 charset 也认）", () => {
    expect(textFlavor("notes", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(textFlavor("notes", "text/plain; charset=utf-8")).toBe("plain");
    expect(textFlavor("data", "application/json; charset=utf-8")).toBe("plain");
    expect(textFlavor("data", "application/jsonp")).toBeNull();
  });
});

describe("openMode：文本预览，其余手机分享 / 桌面下载", () => {
  test("文本类两端都预览", () => {
    expect(openMode("a.md", "", { mobile: true })).toBe("preview");
    expect(openMode("a.md", "", { mobile: false })).toBe("preview");
    expect(openMode("x", "text/plain", { mobile: false })).toBe("preview");
  });
  test("pdf / zip：手机分享，桌面下载", () => {
    expect(openMode("a.pdf", "application/pdf", { mobile: true })).toBe("share");
    expect(openMode("a.pdf", "application/pdf", { mobile: false })).toBe("download");
    expect(openMode("a.zip", "application/zip", { mobile: true })).toBe("share");
  });
});

describe("clipPreview：超过上限只显示开头（按 UTF-8 字节）", () => {
  test("没超：原样、不截", () => {
    expect(clipPreview("hello")).toEqual({ shown: "hello", truncated: false });
    const exact = "a".repeat(PREVIEW_LIMIT);
    expect(clipPreview(exact)).toEqual({ shown: exact, truncated: false });
  });
  test("ASCII 超了：截到正好上限", () => {
    const r = clipPreview("a".repeat(PREVIEW_LIMIT + 10));
    expect(r.truncated).toBe(true);
    expect(r.shown.length).toBe(PREVIEW_LIMIT);
  });
  test("中文按字节算（3 字节一个字），不切断字符", () => {
    const r = clipPreview("中".repeat(10), 10);
    expect(r).toEqual({ shown: "中中中", truncated: true });
    expect(new TextEncoder().encode(r.shown).length).toBeLessThanOrEqual(10);
  });
  test("不把 emoji 代理对切成半个", () => {
    const r = clipPreview("ab😀😀😀", 7); // a b = 2 字节，😀 = 4 字节
    expect(r).toEqual({ shown: "ab😀", truncated: true });
    expect(r.shown).not.toContain("�");
  });
  test("字节数刚好等于上限的多字节文本不算截断", () => {
    expect(clipPreview("中中", 6)).toEqual({ shown: "中中", truncated: false });
  });
});

describe("shareFile：分享结果分类", () => {
  const blob = new Blob(["# hi"], { type: "text/markdown" });
  const named = (name: string) => Object.assign(new Error(name), { name });
  type Payload = Parameters<NonNullable<ShareNav["share"]>>[0];

  test("能分享文件：传 files，成功 → shared", async () => {
    let got: Payload | undefined;
    const nav: ShareNav = { canShare: () => true, share: async (d) => void (got = d) };
    expect(await shareFile(blob, "a.md", undefined, nav)).toBe("shared");
    expect(got?.files?.[0]?.name).toBe("a.md");
  });
  test("手势过期 NotAllowedError → blocked；用户取消 AbortError → cancelled", async () => {
    const reject = (n: string): ShareNav => ({ canShare: () => true, share: async () => Promise.reject(named(n)) });
    expect(await shareFile(blob, "a.pdf", undefined, reject("NotAllowedError"))).toBe("blocked");
    expect(await shareFile(blob, "a.pdf", undefined, reject("AbortError"))).toBe("cancelled");
    expect(await shareFile(blob, "a.pdf", undefined, reject("DataError"))).toBe("unsupported");
  });
  test("不能分享文件：有文本就分享文本，没有 → unsupported（调用方退回下载）", async () => {
    let got: Payload | undefined;
    const nav: ShareNav = { canShare: () => false, share: async (d) => void (got = d) };
    expect(await shareFile(blob, "a.md", "# hi", nav)).toBe("shared");
    expect(got).toEqual({ title: "a.md", text: "# hi" });
    expect(await shareFile(blob, "a.pdf", undefined, nav)).toBe("unsupported");
    expect(await shareFile(blob, "a.md", "# hi", {})).toBe("unsupported");
  });
});

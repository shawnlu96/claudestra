/**
 * web-IMGSAVE1：正文图片分组（web/components/domd/body-image-group.ts）、查看器保存适配（web/features/media/body-image-save.ts）、
 * 顶栏安全区（web/features/media/body-image-safe-area.ts）的纯逻辑。真实入口与截图在 tests/web-body-image-browser.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { BODY_INLINE_KEY, actionFor, attachmentName, groupFor, type BodyImageEl, type BodyImageEntry } from "@/components/domd/body-image-group";
import { NOTICE_CSS, NOTICE_TEXT, fileFor, flashNotice, saveSlide, type SaveDeps } from "@/features/media/body-image-save";
import { TOP_BAR_INSET, insetTopBar } from "@/features/media/body-image-safe-area";
import type { ShareNav } from "@/features/chat/attachment-share";

/** 假 <img>：pos = 文档顺序，link = 是否嵌在 <a href> 里 */
function img(pos: number, o: { link?: boolean; loaded?: boolean; connected?: boolean } = {}): BodyImageEl & { pos: number } {
  return {
    pos,
    isConnected: o.connected ?? true,
    complete: true,
    naturalWidth: o.loaded === false ? 0 : 10,
    closest: (sel: string) => (sel.startsWith("a") && o.link ? {} : null),
    compareDocumentPosition(other: never) {
      return (other as { pos: number }).pos > pos ? 4 : 2;
    },
  };
}
const att = (name: string) => `/api/v1/attachments/${encodeURIComponent(name)}?d=2026-10-12`;

describe("groupFor：同组正文图按文档顺序", () => {
  test("附件 / data: / blob: 进组，按正文顺序排，从点的那张开始；外链、链接里、未加载、已卸载的不进", () => {
    const [a, b, c, ext, linked, broken, gone] = [img(3), img(1), img(2), img(4), img(5, { link: true }), img(6, { loaded: false }), img(7, { connected: false })];
    const entries: BodyImageEntry[] = [
      { el: a, url: att("图 1.png"), kind: "attachment", label: "" },
      { el: b, url: "data:image/png;base64,AAAA", kind: "inline", label: "流程图" },
      { el: c, url: "blob:http://x/1", kind: "inline", label: "" },
      { el: ext, url: "https://images.example/a.png", kind: "external", label: "" },
      { el: linked, url: att("l.png"), kind: "attachment", label: "" },
      { el: broken, url: att("x.png"), kind: "attachment", label: "" },
      { el: gone, url: att("y.png"), kind: "attachment", label: "" },
      { el: b, url: "data:image/png;base64,AAAA", kind: "inline", label: "流程图" }, // 重复登记只算一张
    ];
    const g = groupFor(entries, a)!;
    expect(g.start).toBe(2);
    expect(g.slides.map((s) => s.url)).toEqual(["data:image/png;base64,AAAA", "blob:http://x/1", att("图 1.png")]);
    expect(g.slides.map((s) => s.name)).toEqual(["image-1", "image-2", "图 1.png"]);
    expect(g.slides[0]).toMatchObject({ key: `${BODY_INLINE_KEY}1:data:image/png;base64,AAAA`, saveUrl: "data:image/png;base64,AAAA", caption: "流程图" });
    expect(new Set(g.slides.map((s) => s.key)).size).toBe(3);
    expect(groupFor(entries, ext)).toBeNull();
    expect(groupFor(entries, linked)).toBeNull();
    expect(groupFor(entries, broken)).toBeNull();
  });
  test("同名附件出现两次：两张、key 按出现位置区分", () => {
    const [x, y] = [img(1), img(2)];
    const g = groupFor([{ el: y, url: att("same.png"), kind: "attachment", label: "" }, { el: x, url: att("same.png"), kind: "attachment", label: "" }], y)!;
    expect(g.start).toBe(1);
    expect(g.slides.map((s) => s.name)).toEqual(["same.png", "same.png"]);
    expect(g.slides[0].key).not.toBe(g.slides[1].key);
  });
  test("点击动作：链接里一律交给链接；外链新窗口；附件 / 内联进查看器；被拦下的不动", () => {
    expect(actionFor("attachment", img(1, { link: true }))).toBe("none");
    expect(actionFor("external", img(1, { link: true }))).toBe("none");
    expect(actionFor("external", img(1))).toBe("external");
    expect(actionFor("inline", img(1))).toBe("viewer");
    expect(actionFor("blocked", img(1))).toBe("none");
    expect(attachmentName(att("报告 v2.png"))).toBe("报告 v2.png");
  });
});

describe("fileFor：保存文件名与 MIME", () => {
  const inline = { key: `${BODY_INLINE_KEY}2:data:x`, saveUrl: "data:x", name: "image-2" };
  test("内联图按实际 MIME 补扩展名", () => {
    expect(fileFor(inline, new Blob(["x"], { type: "image/png" })).name).toBe("image-2.png");
    expect(fileFor(inline, new Blob(["x"], { type: "image/jpeg" })).name).toBe("image-2.jpg");
    expect(fileFor(inline, new Blob(["x"], { type: "image/svg+xml" })).name).toBe("image-2.svg");
  });
  test("MIME 缺失 / 认不出：不冒充 PNG，按二进制给 .bin", () => {
    for (const type of ["", "image/x-made-up"]) {
      const f = fileFor(inline, new Blob(["x"], { type }));
      expect(f.name).toBe("image-2.bin");
      expect(f.blob.type).toBe("application/octet-stream");
    }
  });
  test("附件 / 媒体索引原名不动；没名字沿用旧口径", () => {
    expect(fileFor({ key: "m1", saveUrl: "/api/v1/media/m1/raw", name: "IMG_1.HEIC" }, new Blob(["x"], { type: "image/heic" })).name).toBe("IMG_1.HEIC");
    expect(fileFor({ key: "m1", saveUrl: "u", name: "" }, new Blob(["x"])).name).toBe("image.png");
  });
});

/** 记录 share 调用；mode 决定 share 的结局 */
function harness(mode: "ok" | "abort" | "notallowed" | "typeerror" | "noshare", native = false) {
  const log = { fetched: [] as string[], shared: [] as File[], saved: [] as string[], syncShare: 0 };
  const nav: ShareNav = {
    canShare: mode === "noshare" ? () => false : () => true,
    share: async (d) => {
      log.shared.push(...(d.files ?? []));
      log.syncShare++;
      if (mode === "abort") throw Object.assign(new Error("x"), { name: "AbortError" });
      if (mode === "notallowed") throw Object.assign(new Error("x"), { name: "NotAllowedError" });
      if (mode === "typeerror") throw new TypeError("type");
    },
  };
  const deps: SaveDeps = {
    nav,
    held: new Map(),
    native: () => native,
    fetch: async (u) => {
      log.fetched.push(u);
      if (u.includes("missing")) throw new Error("attachment 404");
      return new Blob([`bytes:${u}`], { type: "image/jpeg" });
    },
    save: (b, name) => {
      if (name.includes("boom")) throw new Error("download");
      log.saved.push(`${name}:${b.type}`);
    },
  };
  return { log, deps };
}
const slide = (url: string, name = "a.jpg") => ({ key: url, saveUrl: url, name });

describe("saveSlide：同手势分享与可见失败", () => {
  test("已解码：share 在这次调用的同步栈里发生，files 字节 / 文件名 / MIME 正确，不下载", async () => {
    const { log, deps } = harness("ok");
    const p = saveSlide(slide("/api/v1/attachments/a.jpg"), new Blob(["decoded"], { type: "image/jpeg" }), deps);
    expect(log.syncShare).toBe(1); // 还没 await 就已经调到 share
    expect(await p).toBeNull();
    expect(log.fetched).toEqual([]);
    expect(await log.shared[0].text()).toBe("decoded");
    expect([log.shared[0].name, log.shared[0].type]).toEqual(["a.jpg", "image/jpeg"]);
    expect(log.saved).toEqual([]);
  });
  test("没解码：现取后被拒（NotAllowedError）→ 提示再点一次；第二次点击直接同步 share 已取到的 Blob", async () => {
    const { log, deps } = harness("notallowed");
    const p = saveSlide(slide("/api/v1/attachments/r.jpg"), undefined, deps);
    expect(log.syncShare).toBe(0); // 要先取图：share 不在同步栈里
    expect(await p).toBe("retry");
    expect(NOTICE_TEXT.retry).toBe("再点一次保存");
    deps.nav!.share = async (d) => void (log.shared.push(...(d.files ?? [])), log.syncShare++);
    const before = log.syncShare;
    const again = saveSlide(slide("/api/v1/attachments/r.jpg"), undefined, deps);
    expect(log.syncShare).toBe(before + 1);
    expect(await again).toBeNull();
    expect(log.fetched).toEqual(["/api/v1/attachments/r.jpg"]); // 第二次没再取
  });
  test("重试缓存只属于一个查看器：A 被拒后关闭、切到 B 保存同路径图，取 B 的原图而不是 A 的旧字节", async () => {
    const url = "/api/v1/attachments/same.jpg";
    const a = harness("notallowed");
    a.deps.fetch = async () => new Blob(["machine-A-original"], { type: "image/jpeg" });
    expect(await saveSlide(slide(url), undefined, a.deps)).toBe("retry");
    a.deps.held.clear(); // 查看器 destroy
    const b = harness("ok"); // 切机器后新开的查看器：自己的 held
    b.deps.fetch = async (u) => (b.log.fetched.push(u), new Blob(["machine-B-original"], { type: "image/jpeg" }));
    expect(await saveSlide(slide(url), undefined, b.deps)).toBeNull();
    expect(b.log.fetched).toEqual([url]);
    expect(await b.log.shared[0].text()).toBe("machine-B-original");
    // 即使 A 的查看器没关，B 的查看器也看不到 A 留着的 Blob
    const a2 = harness("notallowed");
    a2.deps.fetch = async () => new Blob(["machine-A-original"], { type: "image/jpeg" });
    expect(await saveSlide(slide(url), undefined, a2.deps)).toBe("retry");
    const b2 = harness("ok");
    b2.deps.fetch = async () => new Blob(["machine-B-original"], { type: "image/jpeg" });
    expect(await saveSlide(slide(url), undefined, b2.deps)).toBeNull();
    expect(await b2.log.shared[0].text()).toBe("machine-B-original");
  });
  test("取消不报错、不下载", async () => {
    const { log, deps } = harness("abort");
    expect(await saveSlide(slide("u1"), new Blob(["x"], { type: "image/png" }), deps)).toBeNull();
    expect(log.saved).toEqual([]);
  });
  test("取图失败：可见提示，不当成功", async () => {
    const { deps } = harness("ok");
    expect(await saveSlide(slide("/api/v1/attachments/missing.png"), undefined, deps)).toBe("failed");
  });
  test("不支持文件分享 / 系统拒绝类型：普通网页下载（正确文件名），壳里提示截屏，下载抛错也提示", async () => {
    for (const mode of ["noshare", "typeerror"] as const) {
      const web = harness(mode);
      expect(await saveSlide({ key: `${BODY_INLINE_KEY}1:data:x`, saveUrl: `data:${mode}`, name: "image-1" }, undefined, web.deps)).toBeNull();
      expect(web.log.saved).toEqual(["image-1.jpg:image/jpeg"]);
      const shell = harness(mode, true);
      expect(await saveSlide(slide(`n-${mode}`), undefined, shell.deps)).toBe("nosave");
      expect(shell.log.saved).toEqual([]);
      expect(await saveSlide(slide(`b-${mode}`, "boom.jpg"), undefined, harness(mode).deps)).toBe("nosave");
    }
    expect(NOTICE_TEXT.nosave).toBe("这台设备不能保存图片，可以截屏");
  });
});

describe("flashNotice / 顶栏安全区", () => {
  test("提示是顶栏里的独立浮层（可换行、不改按钮）；连点只留一个", () => {
    const boxes: { textContent: string | null; style: { cssText: string }; attrs: Record<string, string>; gone: boolean }[] = [];
    const bar = { appendChild: (n: unknown) => void boxes.push(n as (typeof boxes)[number]) };
    const el = { innerHTML: "<svg/>", parentElement: bar, ownerDocument: { createElement: () => {
      const b = { className: "", textContent: null as string | null, style: { cssText: "" }, attrs: {} as Record<string, string>, gone: false,
        setAttribute: (k: string, v: string) => void (b.attrs[k] = v), remove: () => void (b.gone = true) };
      return b;
    } } };
    flashNotice(el, "再点一次保存");
    flashNotice(el, "这台设备不能保存图片，可以截屏");
    expect(el.innerHTML).toBe("<svg/>");
    expect(boxes.map((b) => b.gone)).toEqual([true, false]);
    expect(boxes[1]).toMatchObject({ textContent: "这台设备不能保存图片，可以截屏", attrs: { role: "status" } });
    expect(boxes[1].style.cssText).toBe(NOTICE_CSS);
    expect(NOTICE_CSS).toContain("white-space:normal");
    expect(NOTICE_CSS).toContain("max-width:calc(100% - 16px)");
    expect(() => flashNotice({ ...el, parentElement: null }, "x")).not.toThrow();
  });
  test("顶栏上沿让 safe-area-inset-top，左右让各自 inset；没有元素不抛错", () => {
    const set: Record<string, string> = {};
    insetTopBar({ style: { setProperty: (k, v) => void (set[k] = v) } });
    expect(set.top).toContain("env(safe-area-inset-top");
    expect(set.left).toContain("env(safe-area-inset-left");
    expect(set.right).toContain("env(safe-area-inset-right");
    expect(set).toEqual(TOP_BAR_INSET);
    expect(() => insetTopBar(undefined)).not.toThrow();
  });
});

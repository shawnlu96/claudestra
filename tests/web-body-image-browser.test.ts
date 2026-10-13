/**
 * web-IMGSAVE1 真实入口浏览器回归：真 ChatStoreProvider + 真 Message（AssistantBody / TextBlock / Domd / SafeImg）+ 真 AttachmentStrip，
 * 真 PhotoSwipe 查看器。图片全部合成；附件 API、媒体索引由回环夹具服务给；外链（images.example / links.example）由浏览器拦截给，
 * 其余非回环请求一律 abort 并判失败。navigator.share / canShare、window.open、原生壳（window.Capacitor）都是假的。
 * 截图：BODY_IMAGE_SHOTS_DIR=<目录> 留图（缺省写临时目录、跑完删掉）。改前对照：在基线上带 BODY_IMAGE_SHOTS_BEFORE=1 只拍改前图。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const BEFORE = process.env.BODY_IMAGE_SHOTS_BEFORE === "1";
const work = mkdtempSync(join(tmpdir(), "cstra-test-body-image-"));
const shotsDir = process.env.BODY_IMAGE_SHOTS_DIR ? resolve(process.env.BODY_IMAGE_SHOTS_DIR) : join(work, "shots");
const EXT_IMG = "https://images.example/a.png";

/** 合成 PNG：底色 + 斜纹（看得出是哪张） */
function png(w: number, h: number, a: number[], b: number[]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set((x + y) % 90 < 30 ? b : a, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(td.length + 8);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(td) >>> 0, 4 + td.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const FILES: Record<string, Buffer> = {
  "strip-a.png": png(480, 300, [70, 110, 200], [230, 236, 250]),
  "slow.png": png(480, 300, [140, 80, 190], [240, 230, 250]),
  "body-a.png": png(520, 300, [40, 150, 100], [220, 245, 230]),
  "link-a.png": png(360, 200, [220, 130, 40], [250, 235, 210]),
};
const INLINE = png(200, 120, [200, 60, 80], [250, 220, 225]);
const EXTERNAL = png(300, 180, [90, 90, 90], [230, 230, 230]);
const MEDIA = ["m0", "m1", "m2", "m3", "m4"].map((id, i) => ({ id, agent: "agent-fx", sessionId: i < 2 ? "s-old" : "s-new", seq: 10 + i, ts: null, dir: "in",
  sender: null, senderId: null, name: i === 4 ? "strip-a.png" : `old-${i}.png`, size: 100, mime: "image/png", kind: "image", cat: "image", available: true }));

const fixture = (inline: string) => `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "photoswipe/dist/photoswipe.css";
import { ChatStoreProvider, useChatStoreApi } from "@/features/chat/chat-store";
import { Message } from "@/features/chat/components/message-list";
async function jpeg(color, label) {
  const c = document.createElement("canvas"); c.width = 420; c.height = 260;
  const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, 420, 260); g.fillStyle = "#fff"; g.font = "bold 40px sans-serif"; g.fillText(label, 40, 140);
  return URL.createObjectURL(await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9)));
}
const A = "/api/v1/attachments/";
function list(blob, dead, extra) {
  return [
    { id: "u1", role: "user", content: "附件条两张（对照）", ts: "2026-10-12T03:00:00Z",
      attachments: [{ kind: "image", name: "strip-a.png", url: A + "strip-a.png" }, { kind: "image", name: "slow.png", url: A + "slow.png" }] },
    { id: "a1", role: "assistant", content: "", ts: "2026-10-12T03:01:00Z", streamed: true, segments: [
      { kind: "text", text: "第一段正文：附件图与内联图\\n\\n![附件图](" + A + "body-a.png)\\n\\n![内联图](${inline})" },
      { kind: "text", text: "第二段（仍在生长）：blob 图、外链与链接里的图\\n\\n![blob 图](" + blob + ")\\n\\n![外链图](${EXT_IMG})\\n\\n" +
        "[![a](${EXT_IMG})](https://links.example/)\\n\\n[![链接里的附件](" + A + "link-a.png)](https://links.example/doc)" + extra },
    ] },
    { id: "a2", role: "assistant", content: "", ts: "2026-10-12T03:02:00Z", segments: [
      { kind: "reply", text: "另一条消息，同名图：\\n\\n![同名附件](" + A + "body-a.png)\\n\\n![失效对象地址](" + dead + ")" } ] },
  ];
}
function App({ blob, dead }) {
  const store = useChatStoreApi();
  const [gen, setGen] = useState(0);
  const [extra, setExtra] = useState("");
  const [opened, setOpened] = useState([]);
  Object.assign(window, { __store: store, __remount: () => setGen((g) => g + 1), __grow: (s) => setExtra((x) => x + s),
    __onOpen: (a) => setOpened((o) => [...o, a]) });
  return <div id="cstra-msgs" className="mx-auto w-full max-w-3xl px-4 py-4">
    {list(blob, dead, extra).map((m) => <Message key={m.id + ":" + gen} m={m} streaming={false} isLast={false} awaiting={false} />)}
    {opened.length > 0 && <output id="opened" className="block rounded border border-base-content/20 p-2 text-xs">
      {opened.map((a, i) => <div key={i}>window.open → {a.join(" · ")}</div>)}</output>}
  </div>;
}
Promise.all([jpeg("#2a7", "blob JPEG"), jpeg("#777", "revoked")]).then(([blob, dead]) => {
  window.__revokeDead = () => URL.revokeObjectURL(dead);
  createRoot(document.getElementById("root")).render(<ChatStoreProvider><App blob={blob} dead={dead} /></ChatStoreProvider>);
});
`;

const reqs: { path: string; cookie: string }[] = [];
const unexpected: string[] = [];
let mediaMode: "ok" | "missing" = "missing";
/** 拦住某个附件的下一次取图，直到 release（查看器关闭后迟到的回包） */
let holdAtt: { name: string; release: Promise<void> } | null = null;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  const dir = resolve("web/.next/body-image-fixture");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "fixture.tsx");
  writeFileSync(entry, fixture(`data:image/png;base64,${INLINE.toString("base64")}`));
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", work, "--tsconfig-override", "web/tsconfig.json"],
    { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  unlinkSync(entry);
  if (code) throw new Error(err);
  const webRequire = createRequire(resolve("web/package.json"));
  const globals = resolve("web/app/globals.css");
  const tw = await webRequire("postcss")([webRequire("@tailwindcss/postcss")({ base: resolve("web") })]).process(readFileSync(globals, "utf8"), { from: globals });
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <link rel="stylesheet" href="/tw.css"><link rel="stylesheet" href="/fixture.css"></head>
    <body class="bg-base-100 text-base-content"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/api/")) reqs.push({ path: path + url.search, cookie: req.headers.get("cookie") ?? "" });
    const att = /^\/api\/v1\/attachments\/(.+)$/.exec(path)?.[1];
    if (att && FILES[att]) {
      if (holdAtt?.name === att) await holdAtt.release;
      if (att === "slow.png" && reqs.filter((r) => r.path.includes("slow.png")).length > 1) await Bun.sleep(1500); // 查看器解码慢：保存时缓存还没有
      return new Response(FILES[att], { headers: { "Content-Type": "image/png" } });
    }
    if (path === "/api/v1/media") return mediaPage(url.searchParams);
    if (/^\/api\/v1\/media\/m\d\/raw$/.test(path)) return new Response(FILES["strip-a.png"], { headers: { "Content-Type": "image/png" } });
    if (path === "/api/v1/guard/quarantine") return Response.json({ items: [] }); // Chat Guard 待放行卡：合成空列表
    if (path.startsWith("/api/")) {
      if (!/^\/api\/v1\/(agents|history|events|me|presence|asks|whoami)/.test(path)) unexpected.push(path);
      return Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
    }
    if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (path === "/tw.css") return new Response(tw.css, { headers: { "Content-Type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "fixture", machineName: "fixture", version: "" });
    return /^\/fixture\.(js|css)$/.test(path) ? new Response(Bun.file(join(work, path))) : new Response(null, { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 120_000);

afterAll(async () => {
  await browser?.close(); // 先关浏览器再停服务：反过来浏览器要等被掐断的连接超时，关闭会拖十几秒
  server?.stop(true);
  if (!process.env.BODY_IMAGE_SHOTS_DIR) rmSync(work, { recursive: true, force: true });
}, 60_000);

/** 合成媒体索引：附件条 strip-a.png 在最新一端，往前还有一页旧会话的图 */
function mediaPage(p: URLSearchParams): Response {
  if (mediaMode === "missing") return Response.json({ error: "not found" }, { status: 404 });
  if (p.get("before") === "c-older") return Response.json({ items: MEDIA.slice(0, 2).reverse(), older: null, newer: "c-newer", total: 5, newerCount: 3 });
  return Response.json({ items: MEDIA.slice(2).reverse(), older: "c-older", newer: null, total: 5, newerCount: 0, anchor: "m4" });
}

/** 页面内的假 share / window.open / 点击同步栈标记；mode 由 window.__share.mode 切换 */
const INIT = `(() => {
  const S = window.__share = { mode: "ok", calls: [] };
  let inClick = false;
  addEventListener("click", () => { inClick = true; setTimeout(() => (inClick = false), 0); }, true);
  addEventListener("click", () => { inClick = false; }, false);
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (d) => S.mode !== "cannot" && !!d && Array.isArray(d.files) });
  Object.defineProperty(navigator, "share", { configurable: true, value: (d) => {
    const f = d.files[0];
    const rec = { sync: inClick, name: f.name, type: f.type, b64: "" };
    S.calls.push(rec);
    const done = f.arrayBuffer().then((b) => { rec.b64 = btoa(String.fromCharCode(...new Uint8Array(b))); });
    const err = (name) => Object.assign(new Error(name), { name });
    if (S.mode === "notallowed-once") { S.mode = "ok"; return done.then(() => { throw err("NotAllowedError"); }); }
    if (S.mode === "abort") return done.then(() => { throw err("AbortError"); });
    if (S.mode === "typeerror") return done.then(() => { throw new TypeError("type"); });
    return done;
  } });
  window.__opens = [];
  window.open = (...a) => { window.__opens.push(a); window.__onOpen?.(a); return null; };
})();`;

interface Ctx { ctx: BrowserContext; page: Page; external: string[]; extReqs: { url: string; type: string; headers: Record<string, string> }[] }
async function openPage(width: number, opts: { native?: boolean } = {}): Promise<Ctx> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, colorScheme: "light", locale: "zh-CN", hasTouch: width < 640 });
  await ctx.addCookies([{ name: "cstra_fx", value: "fixture-credential", url: server.url.href }]);
  const external: string[] = [];
  const extReqs: Ctx["extReqs"] = [];
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === server.url.origin) return r.continue();
    if (u.host === "images.example" || u.host === "links.example") {
      extReqs.push({ url: u.href, type: r.request().resourceType(), headers: r.request().headers() });
      return u.host === "images.example" ? r.fulfill({ body: EXTERNAL, contentType: "image/png" }) : r.fulfill({ body: "<p>link</p>", contentType: "text/html" });
    }
    external.push(u.href);
    return r.abort();
  });
  await ctx.addInitScript(INIT);
  if (opts.native) await ctx.addInitScript("window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };");
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(server.url.href);
  await page.waitForFunction(`[...document.querySelectorAll("#cstra-msgs img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 6`);
  return { ctx, page, external, extReqs };
}
const js = <T>(page: Page, expr: string) => page.evaluate(expr) as Promise<T>;
const img = (page: Page, alt: string, n = 0) => page.locator(`#cstra-msgs img[alt="${alt}"]`).nth(n);
const counterIs = (page: Page, text: string) => page.waitForFunction(`document.querySelector(".pswp__counter")?.textContent === "${text}"`);
const saveBtn = (page: Page) => page.locator(".pswp__button--media-save");
/** 保存提示：顶栏下沿的独立浮层（不塞进按钮） */
const notice = (page: Page, text: string) => page.locator(".pswp__save-notice").getByText(text).waitFor();
const shot = (page: Page, name: string, full = true) =>
  page.screenshot({ path: join(shotsDir, `${BEFORE ? "before" : "after"}-${name}.png`), fullPage: full, animations: "disabled" });
/** 点开查看器：等开场动画结束（动画期间方向键、按钮都不响应） */
async function view(page: Page, target: ReturnType<Page["locator"]>, loads = true) {
  await target.click();
  await page.locator(".pswp.pswp--ui-visible").waitFor();
  await page.waitForTimeout(450);
  if (loads) await decoded(page);
}
async function closeViewer(page: Page) {
  await page.keyboard.press("Escape");
  await page.locator(".pswp").waitFor({ state: "detached" });
}
/** 查看器当前这一格已解码出图 */
const decoded = (page: Page) => page.waitForFunction(`(() => { const i = document.querySelector(".pswp__item:not([aria-hidden='true']) img.pswp__img");
  return !!i && i.complete && i.naturalWidth > 0; })()`);
const shares = (page: Page) => js<{ sync: boolean; name: string; type: string; b64: string }[]>(page, "window.__share.calls");
async function lastShare(page: Page, n: number) {
  await page.waitForFunction(`window.__share.calls.length >= ${n} && window.__share.calls.every((c) => c.b64)`);
  return (await shares(page))[n - 1];
}

test.skipIf(BEFORE)("[验收线 1] 正文附件 / data: / blob: 图进 PhotoSwipe，按正文顺序跨段翻、不串另条消息；重挂 / 流式 / 折叠不留重复项", async () => {
  const { ctx, page, external } = await openPage(1280);
  await view(page, img(page, "内联图"));
  await counterIs(page, "2 / 3");
  await page.keyboard.press("ArrowRight");
  await counterIs(page, "3 / 3");
  await page.keyboard.press("ArrowLeft");
  await counterIs(page, "2 / 3");
  await page.keyboard.press("ArrowLeft");
  await counterIs(page, "1 / 3");
  expect(await page.locator(".pswp__media-caption").textContent()).toBe("附件图");
  await closeViewer(page);
  // 另一条消息：同名图只在自己的组里（同名 + 失效对象地址两张）
  await view(page, img(page, "同名附件"));
  await counterIs(page, "1 / 2");
  await closeViewer(page);
  // 附件走带凭据的 API 路由（cookie 在），不是外链
  const att = reqs.filter((r) => r.path.startsWith("/api/v1/attachments/body-a.png"));
  expect(att.length).toBeGreaterThan(0);
  expect(att.every((r) => r.cookie.includes("cstra_fx=fixture-credential"))).toBe(true);
  // 重挂 + 流式改写（最后一段按长度重挂 Domd）后仍是 3 张
  await js(page, "window.__remount()");
  await js(page, "window.__grow('\\n\\n追加的流式文字')");
  await page.getByText("追加的流式文字").waitFor();
  await page.waitForFunction(`document.querySelector('#cstra-msgs img[alt="blob 图"]')?.naturalWidth > 0`);
  await view(page, img(page, "blob 图"));
  await counterIs(page, "3 / 3");
  await closeViewer(page);
  // 折叠第一段（旁白）：图组只剩第二段的 blob；展开后下次打开重建（收起状态按会话记，先给夹具一个会话名）
  await js(page, "window.__store.produce((s) => { s.activeAgent = 'agent-fx'; })");
  await page.getByRole("button", { name: "▴ 收起" }).first().click({ force: true });
  await img(page, "内联图").waitFor({ state: "detached" });
  await view(page, img(page, "blob 图"));
  await page.locator(".pswp.pswp--one-slide").waitFor(); // 只剩一张：PhotoSwipe 不出计数
  await closeViewer(page);
  await page.getByRole("button", { name: "▾ 展开" }).first().click({ force: true });
  await page.waitForFunction(`document.querySelector('#cstra-msgs img[alt="内联图"]')?.naturalWidth > 0`);
  // 键盘入口：Tab 到图上回车
  await img(page, "内联图").focus();
  await page.keyboard.press("Enter");
  await page.locator(".pswp.pswp--ui-visible").waitFor();
  await page.waitForTimeout(450);
  await decoded(page);
  await counterIs(page, "2 / 3");
  await closeViewer(page);
  // 对象地址失效：查看器那一格显示失败
  await js(page, "window.__revokeDead()");
  await view(page, img(page, "失效对象地址"), false);
  await page.locator(".pswp").getByText("无法预览这张图").waitFor();
  await closeViewer(page);
  expect(external).toEqual([]);
  await ctx.close();
}, 60_000);

test.skipIf(BEFORE)("[验收线 2] [验收线 4b] 保存：已解码同一手势同步 share（字节 / 文件名 / MIME），取消不下载，NotAllowedError 提示再点一次", async () => {
  const { ctx, page } = await openPage(1280);
  let downloads = 0;
  page.on("download", () => downloads++);
  await view(page, img(page, "附件图"));
  await decoded(page);
  await saveBtn(page).click();
  const a = await lastShare(page, 1);
  expect(a).toMatchObject({ sync: true, name: "body-a.png", type: "image/png", b64: FILES["body-a.png"].toString("base64") });
  await page.keyboard.press("ArrowRight");
  await decoded(page);
  await saveBtn(page).click();
  expect(await lastShare(page, 2)).toMatchObject({ sync: true, name: "image-2.png", type: "image/png", b64: INLINE.toString("base64") });
  await page.keyboard.press("ArrowRight");
  await decoded(page);
  await saveBtn(page).click();
  const blob = await lastShare(page, 3);
  expect(blob).toMatchObject({ sync: true, name: "image-3.jpg", type: "image/jpeg" });
  expect(Buffer.from(blob.b64, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  // 取消：不报错、不下载
  await js(page, "window.__share.mode = 'abort'");
  await saveBtn(page).click();
  await lastShare(page, 4);
  await page.waitForTimeout(300);
  expect(await page.locator(".pswp__save-notice").count()).toBe(0);
  await closeViewer(page);
  // 附件条：已解码同步 share
  await js(page, "window.__share.mode = 'ok'");
  await view(page, page.locator("img[alt='strip-a.png']"));
  await decoded(page);
  await saveBtn(page).click();
  expect(await lastShare(page, 5)).toMatchObject({ sync: true, name: "strip-a.png", type: "image/png", b64: FILES["strip-a.png"].toString("base64") });
  // 附件条第二张解码还没完：现取后被拒 → 提示「再点一次保存」；第二次点击直接同步 share
  await page.keyboard.press("ArrowRight");
  await js(page, "window.__share.mode = 'notallowed-once'");
  await saveBtn(page).click();
  await notice(page, "再点一次保存");
  expect((await lastShare(page, 6)).sync).toBe(false);
  await saveBtn(page).click();
  expect(await lastShare(page, 7)).toMatchObject({ sync: true, name: "slow.png", type: "image/png", b64: FILES["slow.png"].toString("base64") });
  expect(downloads).toBe(0);
  await ctx.close();
}, 60_000);

test.skipIf(BEFORE)("[验收线 3] 不能分享文件：普通网页下载（文件名正确），壳里与下载抛错提示截屏，取图失败可见", async () => {
  const web = await openPage(1280);
  await js(web.page, "window.__share.mode = 'cannot'");
  await view(web.page, img(web.page, "附件图"));
  await decoded(web.page);
  const [d1] = await Promise.all([web.page.waitForEvent("download"), saveBtn(web.page).click()]);
  expect(d1.suggestedFilename()).toBe("body-a.png");
  await web.page.keyboard.press("ArrowRight");
  await decoded(web.page);
  await js(web.page, "window.__share.mode = 'typeerror'");
  const [d2] = await Promise.all([web.page.waitForEvent("download"), saveBtn(web.page).click()]);
  expect(d2.suggestedFilename()).toBe("image-2.png");
  expect((await shares(web.page)).length).toBe(1); // typeerror 那次确实先尝试了分享
  // 下载本身抛错：同一条截屏提示，不静默
  await js(web.page, "HTMLAnchorElement.prototype.click = function () { throw new Error('download blocked'); }; window.__share.mode = 'cannot'");
  await saveBtn(web.page).click();
  await notice(web.page, "这台设备不能保存图片，可以截屏");
  await closeViewer(web.page);
  // 取图失败（对象地址已失效）：可见提示
  await js(web.page, "window.__revokeDead()");
  await view(web.page, img(web.page, "失效对象地址"), false);
  await saveBtn(web.page).click();
  await notice(web.page, "保存失败");
  await web.ctx.close();
  // 假原生壳：不支持分享时不做无效下载，提示截屏
  const shell = await openPage(390, { native: true });
  let downloads = 0;
  shell.page.on("download", () => downloads++);
  await js(shell.page, "window.__share.mode = 'cannot'");
  await view(shell.page, img(shell.page, "附件图"));
  await decoded(shell.page);
  await saveBtn(shell.page).click();
  await notice(shell.page, "这台设备不能保存图片，可以截屏");
  await shot(shell.page, "viewer-nosave-390", false);
  expect(downloads).toBe(0);
  await shell.ctx.close();
}, 60_000);

test.skipIf(BEFORE)("[验收线 4] 外链：首次只加载、无 Referer；加载后新窗口开原图；链接里的图跟随链接、不进图组", async () => {
  const { ctx, page, external, extReqs } = await openPage(1280);
  expect(extReqs).toEqual([]);
  await view(page, img(page, "附件图")); // 打开 / 翻页正文图组：外链不被收集、不被预取
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await closeViewer(page);
  expect(extReqs).toEqual([]);
  const holders = page.locator("#cstra-msgs [role=button]").filter({ hasText: "点一下加载外链图片" });
  await holders.first().click();
  await img(page, "外链图").waitFor();
  expect(ctx.pages().length).toBe(1); // 首次只加载、不导航
  const loaded = extReqs.filter((r) => r.url === EXT_IMG);
  expect(loaded.length).toBe(1);
  expect(loaded[0].type).toBe("image");
  expect(loaded[0].headers.referer).toBeUndefined();
  expect(loaded[0].headers.cookie).toBeUndefined();
  await page.waitForFunction(`document.querySelector('#cstra-msgs img[alt="外链图"]')?.naturalWidth > 0`);
  await img(page, "外链图").click();
  expect(await js<string[][]>(page, "window.__opens")).toEqual([[EXT_IMG, "_blank", "noopener,noreferrer"]]);
  expect(await page.locator(".pswp").count()).toBe(0);
  await shot(page, "external-fallback-1280");
  // 链接里的外链：点占位只加载；加载后点图跟随外层链接、不进查看器
  await holders.first().click();
  expect(ctx.pages().length).toBe(1);
  await page.waitForFunction(`document.querySelector('#cstra-msgs a img[alt="a"]')?.naturalWidth > 0`);
  const [popup] = await Promise.all([ctx.waitForEvent("page"), img(page, "a").click()]);
  await popup.waitForURL("https://links.example/");
  await popup.close();
  const [popup2] = await Promise.all([ctx.waitForEvent("page"), img(page, "链接里的附件").click()]);
  await popup2.waitForURL("https://links.example/doc");
  await popup2.close();
  expect(await page.locator(".pswp").count()).toBe(0);
  expect(await js<number>(page, "window.__opens.length")).toBe(1);
  expect(extReqs.filter((r) => r.url.startsWith("https://images.example/") && r.type !== "image")).toEqual([]); // 零 CORS 取图
  expect(reqs.some((r) => r.path.includes("images.example"))).toBe(false); // 零代理
  expect(external).toEqual([]);
  await ctx.close();
}, 60_000);

test.skipIf(BEFORE)("[验收线 5] 附件条：索引成功跨会话分页并定位；索引缺失只翻附件条且无定位；保存语义不变", async () => {
  const { ctx, page } = await openPage(1280);
  await js(page, "window.__store.produce((s) => { s.activeAgent = 'agent-fx'; })");
  mediaMode = "ok";
  await view(page, page.locator("img[alt='strip-a.png']"));
  await page.waitForFunction(`document.querySelector(".pswp__counter")?.textContent === "5 / 5"`);
  expect(await page.locator(".pswp__button--media-locate").count()).toBe(1);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(`document.querySelector(".pswp__counter")?.textContent === "4 / 5"`);
  await page.waitForTimeout(300);
  expect(reqs.some((r) => r.path.startsWith("/api/v1/media?") && r.path.includes("before=c-older"))).toBe(true);
  await page.keyboard.press("ArrowRight");
  await saveBtn(page).click();
  expect(await lastShare(page, 1)).toMatchObject({ name: "strip-a.png", type: "image/png" });
  expect(reqs.some((r) => r.path === "/api/v1/media/m4/raw")).toBe(true); // 保存仍取原图
  await page.locator(".pswp__button--media-locate").click();
  await page.waitForFunction("window.__store.state.browsing?.sessionId === 's-new' && window.__store.state.browsing?.anchorSeq === 14");
  await ctx.close();
  mediaMode = "missing";
  const again = await openPage(1280);
  await view(again.page, again.page.locator("img[alt='strip-a.png']"));
  await counterIs(again.page, "1 / 2");
  expect(await again.page.locator(".pswp__button--media-locate").count()).toBe(0);
  await again.ctx.close();
}, 60_000);

test("[验收线 6] [验收线 7] 截图：1280 / 390 正文入口、390 无横向滚动；查看器保存、翻页、顶栏安全区", async () => {
  for (const width of [1280, 390]) {
    const { ctx, page, external } = await openPage(width);
    // 进场动画（chat-msg-in）期间会短暂超出 2px：等它落定，持续超出则超时失败
    await page.waitForFunction("document.documentElement.scrollWidth <= innerWidth", undefined, { timeout: 3000 });
    await shot(page, `page-${width}`);
    if (!BEFORE) {
      await view(page, img(page, "附件图"));
      await decoded(page);
      expect(await saveBtn(page).isVisible()).toBe(true);
      await shot(page, `viewer-save-${width}`, false);
      if (width < 640) {
        await page.mouse.move(330, 420);
        await page.mouse.down();
        await page.mouse.move(60, 420, { steps: 8 });
        await page.mouse.up();
      } else await page.keyboard.press("ArrowRight");
      await page.waitForFunction(`document.querySelector(".pswp__counter")?.textContent === "2 / 3"`);
      await decoded(page);
      await shot(page, `viewer-second-${width}`, false);
      await closeViewer(page);
    }
    expect(external).toEqual([]);
    await ctx.close();
  }
  // 375 宽：顶栏位置（普通浏览器 inset 为 0，和改前一致）
  const { ctx, page } = await openPage(375);
  await view(page, page.locator("img[alt='strip-a.png']"));
  await page.locator(".pswp__top-bar").waitFor();
  const bar = await js<{ top: number; left: number; width: number; style: string }>(page,
    "(() => { const b = document.querySelector('.pswp__top-bar'); const r = b.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, style: b.style.cssText }; })()");
  expect([bar.top, bar.left, bar.width]).toEqual([0, 0, 375]);
  if (!BEFORE) for (const side of ["top", "left", "right"]) expect(bar.style).toContain(`env(safe-area-inset-${side}`);
  await shot(page, "viewer-topbar-375", false);
  await ctx.close();
  expect(unexpected).toEqual([]);
}, 90_000);

test.skipIf(BEFORE)("[验收线 3] [验收线 6] 390 假壳 + 媒体索引（计数 / caption / 定位 / 关闭齐全）：截屏提示完整可见，计数不换行、按钮不被挤", async () => {
  const { ctx, page } = await openPage(390, { native: true });
  await js(page, "window.__store.produce((s) => { s.activeAgent = 'agent-fx'; }); window.__share.mode = 'cannot'");
  mediaMode = "ok";
  await view(page, page.locator("img[alt='strip-a.png']"));
  await counterIs(page, "5 / 5");
  expect(await page.locator(".pswp__button--media-locate").count()).toBe(1);
  const bar = () => js<{ counterH: number; save: number; close: number }>(page, `(() => ({ counterH: document.querySelector(".pswp__counter").offsetHeight,
    save: document.querySelector(".pswp__button--media-save").clientWidth, close: document.querySelector(".pswp__button--close").clientWidth }))()`);
  const before = await bar();
  await saveBtn(page).click();
  await notice(page, "这台设备不能保存图片，可以截屏");
  const box = await js<{ left: number; right: number; sw: number; cw: number; sh: number; ch: number }>(page, `(() => { const b = document.querySelector(".pswp__save-notice");
    const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, sw: b.scrollWidth, cw: b.clientWidth, sh: b.scrollHeight, ch: b.clientHeight }; })()`);
  expect(box.sw).toBeLessThanOrEqual(box.cw); // 不被裁
  expect(box.sh).toBeLessThanOrEqual(box.ch);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(390);
  expect(await bar()).toEqual(before); // 计数仍一行、保存 / 关闭按钮宽度不变
  expect(await saveBtn(page).locator("svg").count()).toBe(1); // 按钮图标不被提示替换
  await shot(page, "viewer-nosave-indexed-390", false);
  mediaMode = "missing";
  await ctx.close();
}, 60_000);

test.skipIf(BEFORE)("[验收线 1] 查看器取图未回就关闭：迟到回包不留 object URL、不再取图", async () => {
  const { ctx, page } = await openPage(1280);
  // 正文里的附件图（含另条消息的同名图）都已由 AuthImg 取完，被拦的只会是查看器自己的取图
  await page.waitForFunction(`[...document.querySelectorAll("#cstra-msgs img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 8`);
  await js(page, `(() => { const live = window.__urls = new Set(); const c = URL.createObjectURL, r = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { const u = c(b); live.add(u); return u; }; URL.revokeObjectURL = (u) => { live.delete(u); r(u); }; })()`);
  let release = () => {};
  holdAtt = { name: "body-a.png", release: new Promise<void>((ok) => (release = ok)) };
  const sent = reqs.length;
  await view(page, img(page, "附件图"), false);
  while (!reqs.slice(sent).some((r) => r.path.startsWith("/api/v1/attachments/body-a.png"))) await Bun.sleep(50);
  await page.waitForTimeout(1000); // 没有缩略图可对齐时开场更久，开场中点关闭不生效
  await page.locator(".pswp__button--close").click();
  await page.locator(".pswp").waitFor({ state: "detached" });
  release();
  holdAtt = null;
  const hits = () => reqs.slice(sent).filter((r) => r.path.startsWith("/api/v1/attachments/body-a.png")).length;
  await page.waitForTimeout(800);
  const settled = hits();
  await page.waitForTimeout(800);
  expect(settled).toBe(1); // 关后迟到回包不再刷新已销毁的查看器，不会再取图绕成请求循环
  expect(hits()).toBe(settled);
  // 只算查看器建的：页面上图片正在用的（AuthImg 全局缓存）不归查看器回收
  expect(await js<string[]>(page, `[...window.__urls].filter((u) => ![...document.images].some((i) => i.src === u))`)).toEqual([]);
  await ctx.close();
}, 60_000);

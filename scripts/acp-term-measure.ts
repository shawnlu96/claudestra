/**
 * 网页终端量尺（ACPT-3）：无头 Chrome 按 iPhone 宽（390px，3x）开真的 xterm（WebGL），52 列铺满，写一行中文 + 一行英文，
 * 截图后逐像素量：每个汉字的两格里墨迹占多宽、汉字之间空多少；英文行右边留多少、溢没溢出。
 * 用法：bun run term-measure [before|after…] [--shot <dir>]（取法在 web/scripts/acp-term-measure-page.ts）。
 * --shot 时另拍整屏：同一批 ACP 会话夹具（tests/helpers）在 52×44 下，改前 = 旧排法 + 旧字号，改后 = tty-layout 窄屏排法 + 汉字补宽。
 * 需要本机装 Chrome（playwright-core channel chrome，或 CHROME_PATH）。
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { join } from "node:path";
import { createTtyLayout } from "../src/lib/acp/tty-layout.ts";
import { renderFixtures } from "../tests/helpers/acp-transcript-fixtures.ts";

const WEB = join(import.meta.dir, "..", "web", "node_modules", "@xterm");
const COLS = 52, ROWS = 8, WIDTH = 390, PAD = 1;
const ZH = "回复：固定版本已在私有副本构建成功，列表、协作和聊";
const EN = "● Bash(env -i HOME=/private/tmp/qwarn2-audit.JaXoMk/home TMPDIR=/private";
const MONO = '"SF Mono", Menlo, Monaco, "Cascadia Mono", "Courier New", monospace';

const PAGE = `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#1e1e2e}#t{width:${WIDTH - 2 * PAD}px;margin:0 ${PAD}px}</style></head><body><div id=t></div></body></html>`;

async function openPage(browser: Browser, fitJs: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 3 });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: join(WEB, "xterm", "css", "xterm.css") });
  await page.addScriptTag({ path: join(WEB, "xterm", "lib", "xterm.js") });
  await page.addScriptTag({ path: join(WEB, "addon-webgl", "lib", "addon-webgl.js") });
  await page.addScriptTag({ content: fitJs });
  return page;
}

/** 整屏：改前是旧的纯文本排法（TTY 上和非 TTY 同一串字），改后是窄屏排法带颜色 */
async function screenShot(browser: Browser, fitJs: string, v: string, file: string) {
  const layout = createTtyLayout();
  const text = v === "before" ? renderFixtures() : renderFixtures((i, at) => layout(i, COLS, at));
  const page = await openPage(browser, fitJs);
  const r = await page.evaluate((a) => (globalThis as any).__setup(a), { v, cols: COLS, rows: 44, text: text.replace(/\n/g, "\r\n"), font: MONO });
  await Bun.write(file, await page.screenshot({ clip: { x: 0, y: r.top, width: WIDTH, height: r.cellH * 44 } }));
  await page.close();
}

async function main() {
  const variants = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--shot");
  const shotDir = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : undefined;
  const fit = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "web", "scripts", "acp-term-measure-page.ts")], format: "iife", target: "browser" });
  const fitJs = await fit.outputs[0]!.text();
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  try {
    for (const v of variants.length ? variants : ["before", "after"]) {
      const page = await openPage(browser, fitJs);
      const r = await page.evaluate((a) => (globalThis as any).__setup(a), { v, cols: COLS, rows: ROWS, text: `${ZH}\r\n\r\n${EN}`, font: MONO });
      const png = await page.screenshot({ clip: { x: 0, y: r.top, width: WIDTH, height: r.cellH * 3 } });
      if (shotDir) await Bun.write(join(shotDir, `term-${v}.png`), png);
      const ink = await page.evaluate((a) => (globalThis as any).__ink(a), { b64: png.toString("base64"), r, zh: ZH, width: WIDTH });
      if (shotDir) await screenShot(browser, fitJs, v, join(shotDir, `screen-${v}.png`));
      const f = (n: number) => n.toFixed(2);
      console.log(`${v.padEnd(8)} 字号 ${f(r.fs)} 字距 ${f(r.ls)} 格宽 ${f(r.cell)} 画布 ${r.screenW}/${r.avail}px  字宽 ${f(ink.inkW)}px`
        + `  汉字间隙 均 ${f(ink.gapMean)}px 最大 ${f(ink.gapMax)}px  墨迹占两格 ${(ink.inkRatio * 100).toFixed(0)}%  英文行右侧空白 ${f(ink.enRightBlank)}px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

await main();

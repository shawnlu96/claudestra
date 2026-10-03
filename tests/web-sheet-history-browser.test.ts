/**
 * 整屏页历史在真 Chrome 里（opt-in）：SHEET_HISTORY_BROWSER=1 bun test tests/web-sheet-history-browser.test.ts
 * 入口 web/features/collab/v4/sheet-history-harness.tsx：外层 popstate 监听先 setState（同 chat.tsx），不用 act、走真实调度。
 * happy-dom 测不到两件事：派发途中被摘掉的监听这次收不到，以及外层先渲染时 effect 把刚退掉的条目压回去（iPhone 左滑弹回）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.SHEET_HISTORY_BROWSER === "1";
let browser: Browser;
let js = "";

beforeAll(async () => {
  if (!enabled) return;
  const out = mkdtempSync(join(tmpdir(), "sheet-history-"));
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/v4/sheet-history-harness.tsx", "--target", "browser",
    "--outdir", out, "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  js = readFileSync(join(out, readdirSync(out).find((f) => f.endsWith(".js"))!), "utf8");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
});
afterAll(async () => { await browser?.close(); });

async function page(): Promise<Page> {
  const p = await browser.newPage();
  await p.route("http://sheet.test/**", (r) => r.request().url().endsWith(".js")
    ? r.fulfill({ contentType: "text/javascript", body: js })
    : r.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/h.js"></script>' }));
  await p.goto("http://sheet.test/");
  await p.waitForFunction("window.sheetApi && typeof window.sheetApi.open === 'function'");
  return p;
}
// evaluate 用字符串表达式：仓库根没有 DOM 类型
const state = (p: Page) => p.evaluate("window.sheetApi.state()") as Promise<{ sel: string | null; hash: string }>;

test.skipIf(!enabled)("系统返回：整屏页收起，条目不被压回去", async () => {
  const p = await page();
  await p.evaluate("window.sheetApi.open('team')");
  await p.waitForFunction("location.hash === '#chat?collab=~team'");
  await p.evaluate("history.back()");
  await p.waitForFunction("window.sheetApi.state().sel === null && location.hash === '#chat'", undefined, { timeout: 3000 });
  expect(await state(p)).toEqual({ sel: null, hash: "#chat" });
  await p.close();
});

test.skipIf(!enabled)("收起后旧 back 在途时打开另一层：落地后新层保留并认领条目", async () => {
  const p = await page();
  await p.evaluate("window.sheetApi.open('team')");
  await p.waitForFunction("location.hash === '#chat?collab=~team'");
  // 收起的 effect 发出 back 之后、遍历落地之前再打开
  await p.evaluate("window.sheetApi.close(); setTimeout(() => window.sheetApi.open('waits'), 0)");
  await p.waitForFunction("location.hash === '#chat?collab=~waits'", undefined, { timeout: 3000 });
  await p.waitForTimeout(300); // 再给一个旧 popstate / 重渲染的机会：新层仍要在
  expect(await state(p)).toEqual({ sel: "waits", hash: "#chat?collab=~waits" });
  await p.close();
});

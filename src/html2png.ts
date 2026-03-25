#!/usr/bin/env bun
/**
 * HTML → PNG 截图工具，使用 Playwright headless Chrome
 * 用法: bun html2png.ts <input.html> <output.png> [width]
 */
import { chromium } from "playwright-core";
import { join } from "path";

const htmlPath = process.argv[2];
const pngPath = process.argv[3] || "/tmp/claude-orchestrator/screenshot.png";
const width = parseInt(process.argv[4] || "1200");

if (!htmlPath) {
  console.error("用法: bun html2png.ts <input.html> <output.png> [width]");
  process.exit(1);
}

// 找 chromium 路径
const homeDir = process.env.HOME || "~";
const cacheDir = join(homeDir, "Library/Caches/ms-playwright");

const browser = await chromium.launch({
  headless: true,
  executablePath: undefined, // 让 playwright 自动找
});

const page = await browser.newPage({
  viewport: { width, height: 800 },
});

await page.goto(`file://${htmlPath}`);
await page.screenshot({
  path: pngPath,
  fullPage: true,
});

await browser.close();
console.log("OK");

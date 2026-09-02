#!/usr/bin/env node
/*
 * 生成 native 壳(Capacitor)的图标/启动图源文件 → ../native/assets/,再由
 * `npx @capacitor/assets generate --ios` 铺成各尺寸。复用 make-icons.mjs 的同一枚 SVG。
 * 用法(web/ 下):node scripts/make-native-assets.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svg } from "./make-icons.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "assets");
fs.mkdirSync(OUT, { recursive: true });
const BG = "#171819";

// 图标:全出血 1024(iOS 自动圆角),glyph 稍收一点留呼吸
// 右下角一枚珊瑚色圆角标:与 PWA 图标区分(两者并存时一眼分清哪个是原生壳)
const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="836" cy="836" r="96" fill="#EC5A72"/><circle cx="836" cy="836" r="96" fill="none" stroke="#171819" stroke-width="22"/></svg>`);
await sharp(Buffer.from(svg(0.94)), { density: 384 }).resize(1024, 1024).composite([{ input: badge }]).png().toFile(path.join(OUT, "icon-only.png"));
// 启动图 2732×2732:纯深底 + 居中 glyph(透明底版本的 SVG:去掉背景矩形)
const glyphOnly = svg(1).replace(/<rect width="1024" height="1024" fill="url\(#bg\)"\/>/, "");
const glyph = await sharp(Buffer.from(glyphOnly), { density: 384 }).resize(720, 720).png().toBuffer();
for (const name of ["splash.png", "splash-dark.png"]) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
    .composite([{ input: glyph, gravity: "centre" }])
    .png()
    .toFile(path.join(OUT, name));
}
console.log("done →", OUT);

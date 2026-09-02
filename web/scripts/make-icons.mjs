#!/usr/bin/env node
/*
 * 生成 Claudestra PWA 安装图标（public/icons/*.png）。
 *
 * 设计语义 = Claudestra 架构本身：中心 hub（Bridge）向 5 个卫星节点「扇出」（一 token
 * 扇出多会话），卫星排成开口朝右的「C」（Claude），右上一颗 sparkle 呼应 "astra/星"。
 * 珊瑚色 #EC5A72（前端 accent）on 近黑底 #171819（dark 主题 base-100）。全出血方底，
 * iOS 自动加圆角；glyph 收在 maskable 安全区内（内容半径 <40% 宽），一张图兼做 any+maskable。
 *
 * 依赖 web 自己的 sharp（bare import，从 scripts/ 向上解析到 ../node_modules）。
 * 用法：node scripts/make-icons.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "icons",
);

const C = 512; // 中心 (viewBox 1024)
const R = 248; // 卫星环半径

// 开口朝右的「C」：只取左半 + 上下（右侧留空）
const SATS = [90, 150, 180, 210, 270].map((deg) => {
  const t = (deg * Math.PI) / 180;
  return { x: C + R * Math.cos(t), y: C - R * Math.sin(t) };
});

const sparkle = (cx, cy, s) => {
  const k = s * 0.2;
  return `M ${cx} ${cy - s} L ${cx + k} ${cy - k} L ${cx + s} ${cy} L ${cx + k} ${cy + k} L ${cx} ${cy + s} L ${cx - k} ${cy + k} L ${cx - s} ${cy} L ${cx - k} ${cy - k} Z`;
};

function svg(glyphScale = 1) {
  // 连接卫星的开口朝右的「C」弧（顶→左→底，半圆），让 C 成形
  const first = SATS[0];
  const last = SATS[SATS.length - 1];
  const cArc = `<path d="M ${first.x.toFixed(1)} ${first.y.toFixed(1)} A ${R} ${R} 0 0 0 ${last.x.toFixed(1)} ${last.y.toFixed(1)}" fill="none" stroke="url(#coral)" stroke-width="18" stroke-linecap="round" opacity="0.32"/>`;
  const spokes = SATS.map(
    (p) =>
      `<line x1="${C}" y1="${C}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="url(#coral)" stroke-width="17" stroke-linecap="round" opacity="0.5"/>`,
  ).join("\n      ");
  const sats = SATS.map(
    (p) =>
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="40" fill="url(#coral)"/>`,
  ).join("\n      ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="#26282b"/>
      <stop offset="100%" stop-color="#141517"/>
    </radialGradient>
    <linearGradient id="coral" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FF7A90"/>
      <stop offset="100%" stop-color="#E8506A"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g transform="translate(${C} ${C}) scale(${glyphScale}) translate(${-C} ${-C})">
    <circle cx="${C}" cy="${C}" r="150" fill="#EC5A72" opacity="0.28" filter="url(#glow)"/>
    ${cArc}
    ${spokes}
    ${sats}
    <circle cx="${C}" cy="${C}" r="66" fill="url(#coral)"/>
    <circle cx="${C}" cy="${C}" r="28" fill="#171819"/>
    <path d="${sparkle(712, 352, 48)}" fill="#FFD7DE"/>
    <path d="${sparkle(360, 690, 26)}" fill="#FFD7DE" opacity="0.85"/>
  </g>
</svg>`;
}

const TARGETS = [
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.86 },
  { file: "apple-touch-icon.png", size: 180, scale: 1 },
];

// v2.22+ 供 native 壳的资产生成脚本复用(import 不产生副作用,只在直接执行时写图标)
export { svg };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "icon.svg"), svg(1));
  for (const t of TARGETS) {
    const buf = Buffer.from(svg(t.scale));
    await sharp(buf, { density: 384 })
      .resize(t.size, t.size)
      .png()
      .toFile(path.join(OUT, t.file));
    console.log("✓", t.file, `${t.size}×${t.size}`);
  }
  console.log("done →", OUT);
}

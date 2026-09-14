export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";

/**
 * 版本信息（Splash 底部署名用）。version 取仓库根 package.json（Claudestra
 * 版本；web 自己的 0.1.0 无意义），commit 每次现取——owner 2026-07-13：
 * 「不一定每次改动都发版，所以加一个 Commit ID」,dev 常驻进程用构建时注入
 * 会陈旧。无鉴权：非敏感元数据,且 Splash 在登录态确立前就要显示。
 *
 * webCommit = 最后一个动过 web/ 的 commit。客户端 bundle 里烤了同一个值
 * （next.config.ts），两者不等才说明**前端真的滞后**（PWA 缓存旧 bundle /
 * 改了前端没重新 build）。此前拿 HEAD 比对，任何只改 src/ 的后端提交都会让
 * 开屏页亮黄字，而 bundle 内容根本没变（owner 2026-08-15 实报）。
 */

let cache: { version: string; commit: string; webCommit: string; at: number } | null = null;

const git = (args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: process.cwd() }, (e, out) => resolve(e ? "" : out.trim()));
  });

/**
 * 每个服务进程只发一次的「清掉浏览器 HTTP 缓存」信号（2026-09-14）。
 *
 * 为什么需要：文档页此前带 `Cache-Control: s-maxage=31536000`（已改成 no-cache），
 * 凡是那之前访问过的浏览器都可能**抱着旧 HTML 不放**——点「新版本已就绪」的刷新
 * 也拿回同一份旧 HTML，commit 永远对不上，提示永远弹（owner 实报「点了刷新没有用」）。
 * 只靠改响应头救不了：旧 HTML 早就在对方缓存里，客户端连问都不问服务器。
 *
 * 好在**陈旧客户端会主动轮询这个端点**（UpdateToast 比对 webCommit）——它的请求
 * 不会被缓存，于是在每次部署/重启后的第一条响应上挂 `Clear-Site-Data: "cache"`，
 * 浏览器收到就丢掉本站 HTTP 缓存，下一次刷新即拿到新 bundle。
 * 只发一次：每个进程的生命周期 = 一次部署，之后恢复正常缓存行为。
 * （注意 Safari 不实现 Clear-Site-Data，那条路仍要人工清站点数据。）
 */
let cacheCleared = false;

export async function GET() {
  if (cache && Date.now() - cache.at < 30_000) {
    const cached = NextResponse.json({ version: cache.version, commit: cache.commit, webCommit: cache.webCommit });
    if (!cacheCleared) {
      cacheCleared = true;
      cached.headers.set("Clear-Site-Data", '"cache"');
    }
    return cached;
  }
  let version = "";
  try {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "..", "package.json"), "utf8")) as {
      version?: string;
    };
    version = pkg.version ?? "";
  } catch {
    /* 根 package.json 读不到就只显示 commit */
  }
  // cwd 是 web/，所以 pathspec 用 `.` —— 与 next.config.ts 烤入时同源同写法
  const [commit, webCommit] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"]),
    git(["log", "-1", "--format=%h", "--", "."]),
  ]);
  cache = { version, commit, webCommit, at: Date.now() };
  const res = NextResponse.json({ version, commit, webCommit });
  if (!cacheCleared) {
    cacheCleared = true;
    res.headers.set("Clear-Site-Data", '"cache"');
  }
  return res;
}

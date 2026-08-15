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

export async function GET() {
  if (cache && Date.now() - cache.at < 30_000) {
    return NextResponse.json({ version: cache.version, commit: cache.commit, webCommit: cache.webCommit });
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
  return NextResponse.json({ version, commit, webCommit });
}

/**
 * 版本与入口配置（docs/design-hosted-frontend.md §13.2 / §13.4）：
 *   GET /api/v1/version    → { version, commit, webCommit?, apiVersion, minClient }（鉴权后；开屏署名 + 前端判兼容）
 *   GET /app-config.json   → { mode:"direct", fp, machineName, version, commit, webCommit? }（bridge 直托管前端时的入口配置，不鉴权、不在 /api/v1 下）
 * version 取仓库根 package.json；commit 现取 `git rev-parse --short HEAD`（不一定每次改动都发版），30 s 缓存；
 * webCommit 是正在托管的 bundle 自己报的（BRIDGE_STATIC_DIR/build-info.json），没托管就没有——前端判「有新版」只信它。
 */
import { hostname } from "node:os";
import { getLocalVersion } from "../../lib/github-release.js";
import { instanceKeySync, keyFingerprint } from "../../lib/instance-key.js";
import { REPO_ROOT } from "../../lib/repo-root.js";
import { readBuildInfo } from "../../lib/static-site.js";
import { apiJson } from "../api-respond.js";

export const API_VERSION = 1;
/** 低于这个版本的前端不认这套 API（前端据此提示升级） */
export const MIN_CLIENT = "2.29.0";
const CACHE_MS = 30_000;

let cache: { version: string; commit: string; at: number } | null = null;

async function gitShortHead(): Promise<string> {
  try {
    const p = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : "";
  } catch (e) {
    console.warn(`⚠️ 读 git commit 失败（版本接口只回 version）: ${(e as Error).message}`);
    return "";
  }
}

async function versionInfo(now: number = Date.now()): Promise<{ version: string; commit: string }> {
  if (cache && now - cache.at < CACHE_MS) return cache;
  const [version, commit] = await Promise.all([getLocalVersion().catch(() => "0.0.0"), gitShortHead()]); // package.json 读不到就只显示 commit
  cache = { version, commit, at: now };
  return cache;
}

function webCommitField(): { webCommit?: string } {
  const webCommit = readBuildInfo(process.env.BRIDGE_STATIC_DIR || "")?.webCommit;
  return webCommit ? { webCommit } : {};
}

export async function versionResponse(): Promise<Response> {
  const { version, commit } = await versionInfo();
  return apiJson(200, { ok: true, version, commit, ...webCommitField(), apiVersion: API_VERSION, minClient: MIN_CLIENT });
}

/** 直托管入口配置：与中继模式的 /app-config.json 同名同用途（bridge.ts 在静态托管之前接它） */
export async function appConfigResponse(): Promise<Response> {
  const key = instanceKeySync();
  const { version, commit } = await versionInfo();
  const body = { mode: "direct", fp: key ? keyFingerprint(key.publicKey) : null, machineName: hostname(), version, commit, ...webCommitField() };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

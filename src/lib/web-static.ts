/**
 * 前端静态包的现状与该说的话——install-cli 的 warnings、doctor 的「前端静态包」组、retire-web 的前置判定共用。
 * 机器上没有 web 服务进程：bridge 按 .env 的 BRIDGE_STATIC_DIR 直接托管 Next 导出（web/out，布局见 lib/static-site.ts），
 * 所以「网页能不能打开」= 目录里有 index.html + bridge 知道这个目录。判定都是纯函数（tests/web-static.test.ts）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Check } from "./doctor.js";
import { readDotenvFileSync } from "./env-file.js";
import { webOutIndex, type WebBuildVerdict } from "./web-build.js";

/** 旧 web 服务（v2.24–v2.28 的 `next start` daemon）；前端改由 bridge 托管后它只该被 `claudestra retire-web` 清掉 */
export const LEGACY_WEB_DAEMON = "com.claudestra.web";

export function legacyWebPlistPath(): string {
  return `${homedir()}/Library/LaunchAgents/${LEGACY_WEB_DAEMON}.plist`;
}

export interface WebStaticState {
  /** .env 的 BRIDGE_STATIC_DIR；空 = bridge 不托管网页 */
  staticDir: string;
  /** web/out/index.html 在不在 */
  built: boolean;
}

export function webStaticState(repoRoot: string): WebStaticState {
  const env = readDotenvFileSync(`${repoRoot}/.env`);
  return { staticDir: (env?.BRIDGE_STATIC_DIR ?? "").trim(), built: existsSync(webOutIndex(repoRoot)) };
}

/** BRIDGE_STATIC_DIR 指向的目录里有没有 index.html（空路径 = false） */
export function staticIndexExists(staticDir: string): boolean {
  return !!staticDir && existsSync(`${staticDir}/index.html`);
}

const FIX_STATIC_DIR = "重跑 bun run setup 选上 Web，或在 .env 加 BRIDGE_STATIC_DIR=<仓库>/web/out 再 launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge";
const FIX_RETIRE = "先 claudestra migrate-web-state（没跑过的话），再 claudestra retire-web";

/** install-cli 装完该警告的事：构建了却没托管、托管路径里没有 index.html、旧 web 服务还在 */
export function webStaticWarnings(s: WebStaticState, x: { staticIndex: boolean; legacyPlist: boolean }): string[] {
  const out: string[] = [];
  if (s.built && !s.staticDir) out.push(`前端已构建(web/out)但 .env 没有 BRIDGE_STATIC_DIR——bridge 不托管网页。${FIX_STATIC_DIR}`);
  if (s.staticDir && !x.staticIndex) out.push(`BRIDGE_STATIC_DIR=${s.staticDir} 里没有 index.html——网页会 404。cd web && npm run build，或把路径改成 <仓库>/web/out`);
  if (x.legacyPlist) out.push(`旧 web 服务 ${LEGACY_WEB_DAEMON} 还在（前端现由 bridge 托管，它已无用）：${FIX_RETIRE}`);
  return out;
}

/** doctor「前端静态包」组：构建时效一行 + BRIDGE_STATIC_DIR 一行 */
export function webStaticChecks(s: WebStaticState, x: { staticIndex: boolean }, v: WebBuildVerdict): Check[] {
  const G = "前端静态包";
  const rows: Check[] = [{
    group: G, name: "构建时效", status: v.status, detail: v.detail,
    // manager update 在已是最新时不会构建；install-cli 每次都按同一判据检查并重建
    ...(v.status !== "ok" ? { fix: "bun src/manager.ts install-cli（或 cd web && npm run build）" } : {}),
  }];
  if (!s.staticDir) {
    rows.push({ group: G, name: "BRIDGE_STATIC_DIR", status: "warn",
      detail: "没配——bridge 不托管网页，本机 / Tailscale / 局域网入口都打不开（中继托管的前端不受影响）", fix: FIX_STATIC_DIR });
  } else if (!x.staticIndex) {
    rows.push({ group: G, name: "BRIDGE_STATIC_DIR", status: "fail", detail: `${s.staticDir} 里没有 index.html——网页 404`,
      fix: "cd web && npm run build；路径不对就把 .env 里的值改成 <仓库>/web/out，再 kickstart bridge" });
  } else {
    rows.push({ group: G, name: "BRIDGE_STATIC_DIR", status: "ok", detail: `bridge 托管 ${s.staticDir}` });
  }
  return rows;
}

/** doctor「launchd daemon」组里的一行：旧 web 服务的 plist 还在就提醒退场（不在就没有这行） */
export function legacyWebDaemonCheck(plistExists: boolean, group: string): Check | null {
  if (!plistExists) return null;
  return {
    group, name: LEGACY_WEB_DAEMON, status: "warn",
    detail: "旧 web 服务还在（前端现由 bridge 托管，它已无用；起不来或崩溃循环都属预期）", fix: FIX_RETIRE,
  };
}

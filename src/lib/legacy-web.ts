/**
 * 从旧 web 服务（v2.24–v2.29 的 `next start` daemon com.claudestra.web）升上来的机器，更新后要自己好起来（owner 2026-09-28：
 * 不回滚，往前补兼容）。三件事：
 *   · autoMigrateLegacyWeb：install-cli（update 也走它）发现旧 plist 就自动迁移——.env 补 BRIDGE_STATIC_DIR 与
 *     BRIDGE_LEGACY_WEB_PORT、搬数据（lib/web-state-migrate.ts）、卸掉起不来的旧 daemon（plist 挪进 backups/，可回滚）；
 *   · 旧端口由 bridge 接管（bridge/legacy-web-port.ts 读 BRIDGE_LEGACY_WEB_PORT）：指向 3333 的入口一个都不用改；
 *   · redeemLegacySession：浏览器带着旧 cstra_session 来，一次性换成 owner 设备凭据（bridge/devices.ts），已登录的不用重新配对。
 */
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeEnvContent, readDotenvFileSync } from "./env-file.js";
import { STATE_DIR } from "./paths.js";
import { LEGACY_WEB_DAEMON, legacyWebPlistPath } from "./web-static.js";
import { migrateWebState, sessionIdHash } from "./web-state-migrate.js";

/** 旧 web 的会话 cookie 名（web/lib/services/auth.service.ts，已删） */
export const LEGACY_SESSION_COOKIE = "cstra_session";
const LEGACY_WEB_PORT_DEFAULT = 3333;

/** 旧 plist 的 `next start -p <port>`；读不出来 = 旧 web 的默认 3333 */
export function legacyWebPortFromPlist(plist: string): number {
  const m = /next start\b[^<]*?(?:-p|--port)[\s=]+(\d{2,5})/.exec(plist);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : LEGACY_WEB_PORT_DEFAULT;
}

/** 旧会话 → 一次性兑换：没过期、没用过才给；兑换即标记 used_at（同一个 cookie 不能换出第二把凭据） */
export function redeemLegacySession(db: Database, sessionId: string, now: Date = new Date()): { username: string } | null {
  if (!sessionId || sessionId.length > 256) return null;
  const hash = sessionIdHash(sessionId);
  const row = db.prepare("SELECT username, expires_at, used_at FROM legacy_sessions WHERE id_hash = ?").get(hash) as
    { username: string; expires_at: string; used_at: string | null } | null;
  if (!row || row.used_at || row.expires_at <= now.toISOString()) return null;
  const r = db.prepare("UPDATE legacy_sessions SET used_at = ? WHERE id_hash = ? AND used_at IS NULL").run(now.toISOString(), hash);
  return r.changes === 1 ? { username: row.username } : null; // 并发兑换：只有一方拿到
}

/** 卸旧 daemon + 把 plist 挪进 backups/（retire-web 与自动迁移共用）；bootout 非 0 多半是「没 load」，目标状态一致照常挪 */
export function retireLegacyWebDaemon(backupDir: string = join(STATE_DIR, "backups"), now: Date = new Date()): { bootedOut: boolean; plist: string | null } {
  const uid = process.getuid?.() ?? 501;
  const bootedOut = spawnSync("launchctl", ["bootout", `gui/${uid}/${LEGACY_WEB_DAEMON}`], { encoding: "utf8" }).status === 0;
  if (!existsSync(legacyWebPlistPath())) return { bootedOut, plist: null };
  mkdirSync(backupDir, { recursive: true });
  const plist = join(backupDir, `${LEGACY_WEB_DAEMON}.plist.${now.toISOString().replace(/[:.]/g, "-")}`);
  renameSync(legacyWebPlistPath(), plist);
  return { bootedOut, plist };
}

/** .env 只补缺：已有的键（用户手配的）一律不动 */
function addMissingEnv(envFile: string, updates: Record<string, string>): string[] {
  const have = readDotenvFileSync(envFile) ?? {};
  const missing = Object.fromEntries(Object.entries(updates).filter(([k]) => !have[k]));
  if (!Object.keys(missing).length) return [];
  writeFileSync(envFile, mergeEnvContent(existsSync(envFile) ? readFileSync(envFile, "utf8") : null, missing, "# Claudestra"));
  return Object.keys(missing);
}

/**
 * install-cli 在 reload daemon 之前调：机器上还有旧 web 的 plist 且新前端已构建 → 迁移并卸旧 daemon（它起不来了），
 * 随后 bridge reload 时带上新 env、接管旧端口。返回给 install-cli 的 warnings（说明做了什么、怎么回滚）。
 */
export async function autoMigrateLegacyWeb(repoRoot: string): Promise<string[]> {
  const plistPath = legacyWebPlistPath();
  if (!existsSync(plistPath)) return [];
  const out = join(repoRoot, "web", "out");
  if (!existsSync(join(out, "index.html"))) return ["旧 web 服务还在，但 web/out 没构建出来：先修好前端构建再重跑 install-cli（旧服务暂不动）"];
  const port = legacyWebPortFromPlist(readFileSync(plistPath, "utf8"));
  const envFile = join(repoRoot, ".env");
  const added = addMissingEnv(envFile, { BRIDGE_STATIC_DIR: out, BRIDGE_LEGACY_WEB_PORT: String(port) });
  const m = await migrateWebState({ env: { webEnvLocal: join(repoRoot, "web", ".env.local"), envFile } });
  const r = retireLegacyWebDaemon();
  const backup = "backup" in m ? `，旧数据备份 ${m.backup}` : "";
  return [
    `旧 web 服务已自动迁移到 bridge：${added.length ? `.env 补了 ${added.join(" / ")}，` : ""}端口 ${port} 由 bridge 接管，已登录的浏览器自动换新凭据${backup}`,
    `回滚：launchctl bootstrap gui/$(id -u) ${r.plist ?? "<备份的 plist>"}（并删掉 .env 里的 BRIDGE_LEGACY_WEB_PORT）`,
  ];
}
